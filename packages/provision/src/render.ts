import { createHash } from "node:crypto";

/** Where things live on the host. */
export const PATHS = {
  app: "/opt/unified-inbox",
  etc: "/etc/unified-inbox",
  env: "/etc/unified-inbox/relay.env",
  dbPassword: "/etc/unified-inbox/db-password",
  caddyfile: "/etc/caddy/Caddyfile",
  unit: "/etc/systemd/system/unified-inbox-relay.service",
  bun: "/usr/local/bin/bun",
  state: "/var/lib/unified-inbox",
} as const;

export const SERVICE = "unified-inbox-relay";
export const SERVICE_USER = "unified-inbox";
export const DB_NAME = "unified_inbox";
export const DB_ROLE = "unified_inbox";
export const RELAY_PORT = 8787;

/** The repository paths synced to the host, relative to the monorepo root. */
export const SYNC_PATHS = ["packages/relay", "packages/shared", "packages/gui/dist", "package.json", "bun.lock", "tsconfig.base.json"] as const;
export const SYNC_EXCLUDES = ["node_modules", "test", ".DS_Store"] as const;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Caddy terminates TLS for the domain (automatic HTTPS) and proxies to the
 * relay on loopback. reverse_proxy copies upstream response headers through
 * unchanged, so the relay's Cross-Origin-* headers reach the browser.
 */
export function renderCaddyfile(domain: string): string {
  return [
    `# Managed by packages/provision; edits are overwritten on the next run.`,
    `${domain} {`,
    `\treverse_proxy 127.0.0.1:${RELAY_PORT}`,
    `}`,
    ``,
  ].join("\n");
}

export function renderEnv(domain: string, dbPassword: string): string {
  return [
    `# Managed by packages/provision; edits are overwritten on the next run.`,
    `DATABASE_URL=postgres://${DB_ROLE}:${dbPassword}@127.0.0.1:5432/${DB_NAME}`,
    `RELAY_PORT=${RELAY_PORT}`,
    `RELAY_HOST=127.0.0.1`,
    `RELAY_PUBLIC_ORIGIN=https://${domain}`,
    `RELAY_GUI_DIR=${PATHS.app}/packages/gui/dist`,
    ``,
  ].join("\n");
}

export function renderUnit(): string {
  return [
    `# Managed by packages/provision; edits are overwritten on the next run.`,
    `[Unit]`,
    `Description=Unified Inbox relay`,
    `After=network-online.target postgresql.service`,
    `Wants=network-online.target`,
    `Requires=postgresql.service`,
    ``,
    `[Service]`,
    `Type=simple`,
    `User=${SERVICE_USER}`,
    `Group=${SERVICE_USER}`,
    `WorkingDirectory=${PATHS.app}`,
    `EnvironmentFile=${PATHS.env}`,
    `Environment=HOME=${PATHS.state}`,
    `Environment=NODE_ENV=production`,
    `StateDirectory=${SERVICE_USER}`,
    `ExecStart=${PATHS.bun} run packages/relay/src/server.ts`,
    `Restart=always`,
    `RestartSec=3`,
    `NoNewPrivileges=true`,
    `PrivateTmp=true`,
    `ProtectSystem=strict`,
    `ProtectHome=true`,
    `ReadWritePaths=${PATHS.state}`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join("\n");
}

/** The probe script run on a host to learn its state; prints key=value lines. */
export function renderProbe(): string {
  return [
    `# unified-inbox probe`,
    `set -u`,
    `export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }`,
    `echo "bun=$(yes_no test -x ${PATHS.bun})"`,
    `echo "postgres=$(yes_no systemctl is-active postgresql)"`,
    `echo "role=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_ROLE}'" 2>/dev/null || true)"`,
    `echo "db=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null || true)"`,
    `echo "caddy=$(yes_no command -v caddy)"`,
    `echo "user=$(yes_no id -u ${SERVICE_USER})"`,
    `echo "caddyfile_sha=$(sha256sum ${PATHS.caddyfile} 2>/dev/null | cut -d' ' -f1)"`,
    `echo "env_sha=$(sha256sum ${PATHS.env} 2>/dev/null | cut -d' ' -f1)"`,
    `echo "unit_sha=$(sha256sum ${PATHS.unit} 2>/dev/null | cut -d' ' -f1)"`,
    `echo "db_password=$(cat ${PATHS.dbPassword} 2>/dev/null || true)"`,
    `echo "service_enabled=$(systemctl is-enabled ${SERVICE} 2>/dev/null || true)"`,
    `echo "service_active=$(systemctl is-active ${SERVICE} 2>/dev/null || true)"`,
    ``,
  ].join("\n");
}
