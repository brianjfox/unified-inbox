import type { CreateOptions, DropletFacts, HostFacts, SshTarget, Step } from "./types.ts";
import { ProvisionError } from "./types.ts";
import { DB_NAME, DB_ROLE, PATHS, SERVICE, SERVICE_USER, renderCaddyfile, renderEnv, renderUnit, sha256 } from "./render.ts";
import { rsyncCommand } from "./remote.ts";

/**
 * The droplet half of `--create`: one step when no droplet carries the name,
 * none when it does (the existing droplet is reused). Pure.
 */
export function planDroplet(opts: CreateOptions, facts: DropletFacts): Step[] {
  if (facts.droplet) return [];
  const keys = opts.sshKey ? [opts.sshKey] : facts.sshKeyIds;
  if (keys.length === 0) {
    throw new ProvisionError(
      "No SSH key to put on the new droplet. Pass --ssh-key <id or fingerprint> or add one to your DigitalOcean account (doctl compute ssh-key import).",
    );
  }
  return [
    {
      id: "droplet-create",
      title: `Create droplet ${opts.name} (${opts.size}, ${opts.region}, ${opts.image})`,
      changes: true,
      local: [
        {
          argv: [
            "doctl",
            "compute",
            "droplet",
            "create",
            opts.name,
            "--region",
            opts.region,
            "--size",
            opts.size,
            "--image",
            opts.image,
            "--ssh-keys",
            keys.join(","),
            "--tag-name",
            "unified-inbox",
            "--wait",
            "--output",
            "json",
          ],
        },
      ],
    },
  ];
}

export type HostPlanInput = {
  domain: string;
  target: SshTarget;
  repoRoot: string;
  /** Used only when the host has no database password yet. */
  newPassword: string;
};

/**
 * The convergence plan for a host, from what the probe found. Every step is
 * conditional on a fact, so a converged host yields only the health check.
 * Pure: it returns steps and runs nothing.
 */
export function planHost(input: HostPlanInput, facts: HostFacts): Step[] {
  const steps: Step[] = [];
  const password = facts.dbPassword ?? input.newPassword;
  const passwordIsNew = facts.dbPassword === null;
  const caddyfile = renderCaddyfile(input.domain);
  const env = renderEnv(input.domain, password);
  const unit = renderUnit();
  const caddyfileChanged = facts.caddyfileSha !== sha256(caddyfile);
  const envChanged = facts.envSha !== sha256(env);
  const unitChanged = facts.unitSha !== sha256(unit);

  if (!facts.bun) {
    steps.push({
      id: "bun",
      title: "Install Bun (official installer) to /usr/local/bin",
      changes: true,
      remote: [
        `apt-get install -y -q curl unzip ca-certificates rsync`,
        `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash`,
        `test -x ${PATHS.bun}`,
      ].join("\n"),
    });
  }

  if (!facts.postgres) {
    steps.push({
      id: "postgres",
      title: "Install PostgreSQL (apt) and start it",
      changes: true,
      remote: [`apt-get update -q`, `apt-get install -y -q postgresql postgresql-contrib`, `systemctl enable --now postgresql`].join("\n"),
    });
  }

  if (!facts.role || !facts.db || passwordIsNew) {
    const lines = [
      `if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_ROLE}'" | grep -q 1; then`,
      `  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${password}'"`,
      `fi`,
    ];
    if (passwordIsNew) lines.push(`sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${DB_ROLE} WITH LOGIN PASSWORD '${password}'"`);
    lines.push(
      `if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then`,
      `  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_ROLE}"`,
      `fi`,
    );
    steps.push({
      id: "database",
      title: `Create role ${DB_ROLE} and database ${DB_NAME} if absent${passwordIsNew ? " (new password kept on the host)" : ""}`,
      changes: true,
      files: passwordIsNew ? [{ path: PATHS.dbPassword, content: password + "\n", mode: "0600" }] : undefined,
      remote: lines.join("\n"),
    });
  }

  if (!facts.caddy) {
    steps.push({
      id: "caddy",
      title: "Install Caddy from its official apt repository",
      changes: true,
      remote: [
        `apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg`,
        `if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then`,
        `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`,
        `fi`,
        `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list`,
        `apt-get update -q`,
        `apt-get install -y -q caddy`,
        `systemctl enable --now caddy`,
      ].join("\n"),
    });
  }

  if (caddyfileChanged) {
    steps.push({
      id: "caddyfile",
      title: `Write ${PATHS.caddyfile} for https://${input.domain} -> 127.0.0.1:8787 and reload Caddy`,
      changes: true,
      files: [{ path: PATHS.caddyfile, content: caddyfile, mode: "0644" }],
      remote: [`caddy validate --config ${PATHS.caddyfile} --adapter caddyfile`, `systemctl reload caddy || systemctl restart caddy`].join("\n"),
    });
  }

  if (!facts.user) {
    steps.push({
      id: "user",
      title: `Create system user ${SERVICE_USER}`,
      changes: true,
      remote: `id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir ${PATHS.state} --create-home --shell /usr/sbin/nologin ${SERVICE_USER}`,
    });
  }

  if (facts.codeChanged) {
    steps.push({
      id: "code",
      title: `Sync the application to ${PATHS.app} and install production dependencies`,
      changes: true,
      local: [rsyncCommand(input.repoRoot, input.target, false)],
      remote: [`cd ${PATHS.app}`, `${PATHS.bun} install --production`, `chown -R root:root ${PATHS.app}`, `chmod -R a+rX ${PATHS.app}`].join("\n"),
    });
  }

  if (envChanged) {
    steps.push({
      id: "env",
      title: `Write ${PATHS.env}`,
      changes: true,
      files: [{ path: PATHS.env, content: env, mode: "0600" }],
    });
  }

  if (unitChanged) {
    steps.push({
      id: "unit",
      title: `Write ${PATHS.unit}`,
      changes: true,
      files: [{ path: PATHS.unit, content: unit, mode: "0644" }],
      remote: `systemctl daemon-reload`,
    });
  }

  const needsStart = !facts.serviceEnabled || !facts.serviceActive;
  const needsRestart = facts.codeChanged || envChanged || unitChanged;
  if (needsStart) {
    steps.push({
      id: "service-start",
      title: `Enable and start ${SERVICE}`,
      changes: true,
      remote: [`systemctl enable --now ${SERVICE}`, ...(needsRestart ? [`systemctl restart ${SERVICE}`] : [])].join("\n"),
    });
  } else if (needsRestart) {
    steps.push({
      id: "service-restart",
      title: `Restart ${SERVICE} (code, environment, or unit changed; the relay migrates on start)`,
      changes: true,
      remote: `systemctl restart ${SERVICE}`,
    });
  }

  steps.push({
    id: "health",
    title: `Check https://${input.domain}/api/health (waits for Caddy's certificate)`,
    changes: false,
    local: [{ argv: ["curl", "-fsS", "--max-time", "15", `https://${input.domain}/api/health`] }],
    retry: { attempts: 24, delayMs: 10_000 },
  });

  return steps;
}
