import type { CommandRunner, Droplet, DropletFacts, HostFacts, SshTarget } from "./types.ts";
import { ProvisionError } from "./types.ts";
import { renderProbe } from "./render.ts";
import { rsyncCommand, rsyncReportsChanges, sshCommand } from "./remote.ts";

type DoctlDroplet = {
  id: number;
  name: string;
  status: string;
  networks?: { v4?: { ip_address: string; type: string }[] };
};

export function parseDroplet(d: DoctlDroplet): Droplet {
  const pub = d.networks?.v4?.find((n) => n.type === "public");
  return { id: d.id, name: d.name, status: d.status, ip: pub?.ip_address ?? null };
}

export async function gatherDropletFacts(runner: CommandRunner, name: string, needKeys: boolean): Promise<DropletFacts> {
  const list = await runner.run({ argv: ["doctl", "compute", "droplet", "list", "--output", "json"] });
  if (list.code !== 0) throw new ProvisionError(`doctl compute droplet list failed (is doctl authenticated? run doctl auth init):\n${list.stderr}`);
  const droplets = (JSON.parse(list.stdout || "[]") as DoctlDroplet[]).filter((d) => d.name === name);
  if (droplets.length > 1) throw new ProvisionError(`${droplets.length} droplets are named ${name}; rename or delete all but one.`);
  let sshKeyIds: string[] = [];
  if (!droplets[0] && needKeys) {
    const keys = await runner.run({ argv: ["doctl", "compute", "ssh-key", "list", "--output", "json"] });
    if (keys.code !== 0) throw new ProvisionError(`doctl compute ssh-key list failed:\n${keys.stderr}`);
    sshKeyIds = (JSON.parse(keys.stdout || "[]") as { id: number }[]).map((k) => String(k.id));
  }
  return { droplet: droplets[0] ? parseDroplet(droplets[0]) : null, sshKeyIds };
}

export async function getDroplet(runner: CommandRunner, name: string): Promise<Droplet | null> {
  const facts = await gatherDropletFacts(runner, name, false);
  return facts.droplet;
}

export function parseProbe(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export async function gatherHostFacts(runner: CommandRunner, target: SshTarget, repoRoot: string): Promise<HostFacts> {
  const probe = await runner.run(sshCommand(target, renderProbe()));
  if (probe.code !== 0) throw new ProvisionError(`Could not probe ${target.user}@${target.host} over ssh:\n${probe.stderr}`);
  const p = parseProbe(probe.stdout);
  const rsync = await runner.run(rsyncCommand(repoRoot, target, true));
  return {
    bun: p.bun === "yes",
    postgres: p.postgres === "yes",
    role: p.role === "1",
    db: p.db === "1",
    caddy: p.caddy === "yes",
    user: p.user === "yes",
    caddyfileSha: p.caddyfile_sha || null,
    envSha: p.env_sha || null,
    unitSha: p.unit_sha || null,
    dbPassword: p.db_password || null,
    serviceEnabled: p.service_enabled === "enabled",
    serviceActive: p.service_active === "active",
    codeChanged: rsyncReportsChanges(rsync),
  };
}
