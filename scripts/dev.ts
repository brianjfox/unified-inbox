#!/usr/bin/env bun
/**
 * One command starts everything for development, with no account and no key:
 *   - Postgres: the one already running on localhost:5432 if any, else an
 *     in-process PGlite served over the Postgres wire protocol (same client,
 *     same code; only the endpoint differs).
 *   - the relay (Bun), serving the GUI it rebuilds on change (Vite watch),
 *   - the connector hub (Node 26), pointed at the local relay.
 * Credentials for Slack and WhatsApp are added later on the Connections screen;
 * until then the hub reports each service's state there.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";

const ROOT = new URL("..", import.meta.url).pathname;
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8787);
const children: Subprocess[] = [];

function log(tag: string, msg: string) {
  console.log(`[dev] ${tag}: ${msg}`);
}

async function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 800);
  });
}

async function ensureDatabase(): Promise<string> {
  if (process.env.DATABASE_URL) {
    log("db", `using DATABASE_URL from the environment`);
    return process.env.DATABASE_URL;
  }
  if (await portOpen("127.0.0.1", 5432)) {
    const user = process.env.PGUSER ?? process.env.USER ?? "postgres";
    const dbName = "unified_inbox";
    const check = spawn(["psql", "-h", "localhost", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${dbName}'`], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(check.stdout).text();
    if (await check.exited, !out.includes("1")) {
      const create = spawn(["psql", "-h", "localhost", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`], { stdout: "inherit", stderr: "inherit" });
      await create.exited;
    }
    log("db", `local Postgres on 5432, database ${dbName}`);
    return `postgres://${user}@localhost:5432/${dbName}`;
  }
  // No server: serve PGlite over the wire protocol on a free port.
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const dataDir = join(ROOT, "tmp", "pglite");
  mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create({ dataDir });
  const port = 54329;
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();
  log("db", `no Postgres found; PGlite listening on 127.0.0.1:${port} (data in tmp/pglite)`);
  return `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

function run(tag: string, cmd: string[], env: Record<string, string>, cwd = ROOT): Subprocess {
  const child = spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const pipe = async (stream: ReadableStream<Uint8Array> | null | number, err: boolean) => {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        (err ? console.error : console.log)(`[${tag}] ${line}`);
      }
    }
  };
  void pipe(child.stdout, false);
  void pipe(child.stderr, true);
  children.push(child);
  child.exited.then((code) => log(tag, `exited with code ${code}`));
  return child;
}

async function main() {
  const databaseUrl = await ensureDatabase();
  const guiDist = join(ROOT, "packages/gui/dist");
  if (!existsSync(join(guiDist, "index.html"))) {
    log("gui", "first build…");
    const first = spawn(["bun", "run", "build"], { cwd: join(ROOT, "packages/gui"), stdout: "inherit", stderr: "inherit" });
    const code = await first.exited;
    if (code !== 0) throw new Error("GUI build failed; see output above");
  }
  run("gui", ["bun", "run", "dev"], {}, join(ROOT, "packages/gui"));
  const relayEnv = {
    DATABASE_URL: databaseUrl,
    RELAY_PORT: String(RELAY_PORT),
    RELAY_HOST: "127.0.0.1",
    RELAY_PUBLIC_ORIGIN: process.env.RELAY_PUBLIC_ORIGIN ?? `http://localhost:${RELAY_PORT}`,
    RELAY_GUI_DIR: guiDist,
  };
  run("relay", ["bun", "run", "packages/relay/src/server.ts"], relayEnv);
  for (let i = 0; i < 100 && !(await portOpen("127.0.0.1", RELAY_PORT)); i++) await Bun.sleep(300);
  if (!(await portOpen("127.0.0.1", RELAY_PORT))) throw new Error("relay did not start");
  run("hub", ["node", "--experimental-strip-types", "--no-warnings", "packages/connector-hub/src/main.ts"], {
    RELAY_URL: `http://localhost:${RELAY_PORT}`,
    HUB_DATA_DIR: process.env.HUB_DATA_DIR ?? join(ROOT, "tmp", "hub"),
    HUB_KEYCHAIN_SERVICE: process.env.HUB_KEYCHAIN_SERVICE ?? "com.unified-inbox.hub.dev",
    HUB_LABEL: process.env.HUB_LABEL ?? "Dev hub",
  });
  console.log(`\n[dev] GUI:   http://localhost:${RELAY_PORT}/\n[dev] API:   http://localhost:${RELAY_PORT}/api/health\n[dev] Stop with Ctrl-C.\n`);
}

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => {
  console.error("[dev] failed:", err.message ?? err);
  shutdown();
});
