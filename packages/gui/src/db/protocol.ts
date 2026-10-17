/** Messages between the main thread and the SQLite worker. */
export type SqlParam = string | number | null;

export type DbRequest =
  | { id: number; op: "open"; filename: string }
  | { id: number; op: "query"; sql: string; params: SqlParam[] }
  | { id: number; op: "exec"; statements: Array<{ sql: string; params: SqlParam[] }> };

export type DbRow = Record<string, SqlParam | Uint8Array>;

export type DbResponse =
  | { id: number; ok: true; rows: DbRow[] }
  | { id: number; ok: true; rows?: undefined }
  | { id: number; ok: false; error: string; code: "opfs-unavailable" | "sqlite" };

export class CacheUnavailableError extends Error {
  constructor(
    public readonly code: "opfs-unavailable" | "sqlite",
    message: string,
  ) {
    super(message);
  }
}
