import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { DbRequest, DbResponse, DbRow, SqlParam } from "./protocol.ts";

/**
 * The local cache's SQLite engine, in a Worker so it can use the
 * OPFS-backed persistent file system. The relay sends the cross-origin
 * isolation headers OPFS needs; without OPFS this worker refuses to open a
 * database and says why, instead of quietly keeping the inbox in memory.
 */
type WorkerScope = { postMessage(msg: DbResponse): void; onmessage: ((ev: MessageEvent<DbRequest>) => void) | null };
const scope = self as unknown as WorkerScope;

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;

function reply(msg: DbResponse): void {
  scope.postMessage(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SQLite reports why it could not install the OPFS VFS through console.warn
 * while initializing; that text is the one thing a person needs to fix it,
 * so it is captured and put in the error instead of lost in a worker's console.
 */
async function initSqlite(): Promise<{ sqlite3: Sqlite3Static; notes: string[] }> {
  const notes: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args: unknown[]) => {
    notes.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    warn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    notes.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    error.apply(console, args);
  };
  try {
    return { sqlite3: await sqlite3InitModule(), notes };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

async function open(filename: string): Promise<void> {
  let notes: string[] = [];
  if (!sqlite3) ({ sqlite3, notes } = await initSqlite());
  // The "opfs" VFS registers only when OPFS and cross-origin isolation are
  // both present; its absence is the authoritative signal.
  if (!sqlite3.capi.sqlite3_vfs_find("opfs") || !sqlite3.oo1.OpfsDb) {
    const env = `crossOriginIsolated=${String(globalThis.crossOriginIsolated)}, SharedArrayBuffer=${typeof SharedArrayBuffer}, storage.getDirectory=${typeof navigator.storage?.getDirectory}, createSyncAccessHandle=${typeof (globalThis as { FileSystemFileHandle?: { prototype?: { createSyncAccessHandle?: unknown } } }).FileSystemFileHandle?.prototype?.createSyncAccessHandle}`;
    throw Object.assign(
      new Error(
        `The Origin Private File System (OPFS) is unavailable in this browser, so the inbox cannot store its local copy. The inbox needs a current Chrome, Edge, Safari or Firefox served over HTTPS with cross-origin isolation. Details: ${env}.${notes.length ? ` SQLite said: ${notes.join(" | ")}` : ""}`,
      ),
      { code: "opfs-unavailable" as const },
    );
  }
  db = new sqlite3.oo1.OpfsDb(filename, "c");
}

function requireDb(): Database {
  if (!db) throw new Error("The cache database is not open");
  return db;
}

function query(sql: string, params: SqlParam[]): DbRow[] {
  const rows: DbRow[] = [];
  requireDb().exec({ sql, bind: params, rowMode: "object", callback: (row) => void rows.push(row as DbRow) });
  return rows;
}

function exec(statements: Array<{ sql: string; params: SqlParam[] }>): void {
  const d = requireDb();
  d.transaction(() => {
    for (const s of statements) d.exec({ sql: s.sql, bind: s.params });
  });
}

scope.onmessage = async (ev) => {
  const req = ev.data;
  try {
    switch (req.op) {
      case "open":
        await open(req.filename);
        reply({ id: req.id, ok: true });
        return;
      case "query":
        reply({ id: req.id, ok: true, rows: query(req.sql, req.params) });
        return;
      case "exec":
        exec(req.statements);
        reply({ id: req.id, ok: true });
        return;
    }
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "opfs-unavailable" ? "opfs-unavailable" : "sqlite";
    reply({ id: req.id, ok: false, error: errorMessage(err), code });
  }
};
