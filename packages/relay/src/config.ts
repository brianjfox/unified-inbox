import type { DBConfig } from "@intx/db";

export type RelayConfig = {
  /** Where the HTTP server listens. */
  port: number;
  host: string;
  /** The public origin viewers and the hub reach the relay at, e.g. https://inbox.example.net */
  publicOrigin: string;
  db: DBConfig;
  /** The one tenant. Its domain is the mail domain principal addresses use. */
  tenant: { id: string; slug: string; name: string; domain: string };
  /** Directory holding the built GUI (index.html and assets). */
  guiDir: string;
};

export class ConfigError extends Error {}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`Missing required environment variable ${name}. See README.md.`);
  return v;
}

/** Parse `postgres://user:pass@host:port/db` into the hub's DBConfig. */
export function dbConfigFromUrl(url: string): DBConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`DATABASE_URL is not a URL: ${url}`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new ConfigError("DATABASE_URL must start with postgres://");
  const database = u.pathname.replace(/^\//, "");
  if (!database) throw new ConfigError("DATABASE_URL must name a database");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    // A URL without a user means the local developer's own role, which is what
    // Homebrew and Postgres.app create; production URLs always name one.
    user: decodeURIComponent(u.username || process.env.PGUSER || process.env.USER || "postgres"),
    password: decodeURIComponent(u.password || ""),
    database,
    ssl: u.searchParams.get("sslmode") === "require",
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const port = Number(env.RELAY_PORT ?? "8787");
  const host = env.RELAY_HOST ?? "127.0.0.1";
  const publicOrigin = (env.RELAY_PUBLIC_ORIGIN ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`).replace(/\/$/, "");
  const domain = env.RELAY_MAIL_DOMAIN ?? new URL(publicOrigin).hostname;
  return {
    port,
    host,
    publicOrigin,
    db: dbConfigFromUrl(required(env, "DATABASE_URL")),
    tenant: { id: "inbox", slug: "inbox", name: "Unified Inbox", domain },
    guiDir: env.RELAY_GUI_DIR ?? new URL("../../gui/dist/", import.meta.url).pathname,
  };
}
