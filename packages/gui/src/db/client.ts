import { CacheUnavailableError, type DbRequest, type DbResponse, type DbRow, type SqlParam } from "./protocol.ts";

type Pending = { resolve: (rows: DbRow[]) => void; reject: (err: Error) => void };

/** Omit that distributes over a union, so each request shape keeps its own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** The main thread's handle on the SQLite worker: typed query and exec. */
export class DbClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "inbox-cache" });
    this.worker.onmessage = (ev: MessageEvent<DbResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.rows ?? []);
      else p.reject(new CacheUnavailableError(res.code, res.error));
    };
    this.worker.onerror = (ev) => {
      const err = new CacheUnavailableError("sqlite", `The cache worker failed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private send(req: DistributiveOmit<DbRequest, "id">): Promise<DbRow[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: DbRequest = { ...req, id };
      this.worker.postMessage(message);
    });
  }

  async open(filename: string): Promise<void> {
    await this.send({ op: "open", filename });
  }

  query(sql: string, params: SqlParam[] = []): Promise<DbRow[]> {
    return this.send({ op: "query", sql, params });
  }

  async exec(statements: Array<{ sql: string; params?: SqlParam[] }>): Promise<void> {
    await this.send({ op: "exec", statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  }
}
