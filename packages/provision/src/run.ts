import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { CommandRunner, CreateOptions, Droplet, HostFacts, Options, SshTarget, Step } from "./types.ts";
import { FRESH_HOST, ProvisionError } from "./types.ts";
import { gatherDropletFacts, gatherHostFacts, getDroplet, parseDroplet } from "./facts.ts";
import { planDroplet, planHost } from "./plan.ts";
import { executeAll, executeStep, type Executor } from "./execute.ts";
import { sshReachableCommand } from "./remote.ts";

export type RunDeps = {
  runner: CommandRunner;
  repoRoot: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Random password for a host that has none yet. */
  newPassword?: () => string;
};

export type RunReport = {
  target: SshTarget;
  droplet: Droplet | null;
  steps: Step[];
  changed: boolean;
};

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

async function waitFor<T>(deps: RunDeps, what: string, attempts: number, delayMs: number, probe: () => Promise<T | null>): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    const value = await probe();
    if (value !== null) return value;
    deps.log(`    waiting for ${what} (${i}/${attempts})`);
    await deps.sleep(delayMs);
  }
  throw new ProvisionError(`Gave up waiting for ${what}.`);
}

/** The droplet half of --create: find or create, then wait for its IPv4 and ssh. */
export async function ensureDroplet(opts: CreateOptions, deps: RunDeps, ex: Executor): Promise<Droplet> {
  if (opts.dryRun) {
    const steps = planDroplet(opts, { droplet: null, sshKeyIds: opts.sshKey ? [] : ["<every-account-ssh-key>"] });
    await executeAll(ex, steps);
    deps.log(`    would wait for the droplet's public IPv4 and for ssh to answer`);
    return { id: 0, name: opts.name, status: "new", ip: "<droplet-ip>" };
  }
  const facts = await gatherDropletFacts(deps.runner, opts.name, !opts.sshKey);
  const steps = planDroplet(opts, facts);
  let droplet = facts.droplet;
  if (droplet) {
    deps.log(`==> Droplet ${droplet.name} exists (id ${droplet.id}, ${droplet.status}${droplet.ip ? `, ${droplet.ip}` : ""}); reusing it`);
  } else {
    const out = await executeStep(ex, steps[0]!);
    const created = JSON.parse(out) as Parameters<typeof parseDroplet>[0][];
    droplet = parseDroplet(created[0]!);
  }
  if (!droplet.ip) {
    droplet = await waitFor(deps, `public IPv4 of ${opts.name}`, 30, 5_000, async () => {
      const d = await getDroplet(deps.runner, opts.name);
      return d?.ip ? d : null;
    });
  }
  const target = { host: droplet.ip!, user: opts.sshUser };
  await waitFor(deps, `ssh on ${target.user}@${target.host}`, 30, 10_000, async () => {
    const r = await deps.runner.run(sshReachableCommand(target));
    return r.code === 0 ? true : null;
  });
  return droplet;
}

/** Converge one host: probe, plan, execute. */
export async function convergeHost(opts: Options, target: SshTarget, deps: RunDeps, ex: Executor): Promise<Step[]> {
  const guiIndex = `${deps.repoRoot}/packages/gui/dist/index.html`;
  if (!existsSync(guiIndex)) {
    const msg = `The GUI bundle ${guiIndex} does not exist. Build it first (bun run --filter @inbox/gui build); the relay serves it.`;
    if (opts.dryRun) deps.log(`    note: ${msg}`);
    else throw new ProvisionError(msg);
  }
  let facts: HostFacts;
  if (opts.dryRun) {
    facts = FRESH_HOST;
  } else {
    deps.log(`==> Probing ${target.user}@${target.host}`);
    facts = await gatherHostFacts(deps.runner, target, deps.repoRoot);
  }
  const steps = planHost({ domain: opts.domain, target, repoRoot: deps.repoRoot, newPassword: (deps.newPassword ?? generatePassword)() }, facts);
  const changes = steps.filter((s) => s.changes);
  deps.log(changes.length === 0 ? `==> ${target.host} is converged; nothing to change` : `==> ${changes.length} step(s) to apply on ${target.host}: ${changes.map((s) => s.id).join(", ")}`);
  if (!opts.dryRun && /^\d+\.\d+\.\d+\.\d+$/.test(target.host)) {
    const addrs = await deps.runner.lookup(opts.domain);
    if (!addrs.includes(target.host)) {
      deps.log(`    warning: ${opts.domain} resolves to [${addrs.join(", ")}], not ${target.host}. Point its A record at ${target.host}; the health check below waits for the certificate, which needs it.`);
    }
  }
  await executeAll(ex, steps);
  return steps;
}

export async function run(opts: Options, deps: RunDeps): Promise<RunReport> {
  const ex: Executor = { runner: deps.runner, target: null, dryRun: opts.dryRun, log: deps.log, sleep: deps.sleep };
  if (opts.dryRun) deps.log(`DRY RUN: printing the plan for a fresh target; nothing is executed and no network is used.`);
  let droplet: Droplet | null = null;
  let target: SshTarget;
  if (opts.mode === "create") {
    droplet = await ensureDroplet(opts, deps, ex);
    target = { host: droplet.ip!, user: opts.sshUser };
  } else {
    target = { host: opts.host, user: opts.sshUser };
  }
  ex.target = target;
  const steps = await convergeHost(opts, target, deps, ex);
  const changed = steps.some((s) => s.changes);
  deps.log(opts.dryRun ? `DRY RUN complete.` : `Done. The relay answers at https://${opts.domain}/api/health${changed ? "" : " (no changes were needed)"}.`);
  return { target, droplet, steps, changed };
}
