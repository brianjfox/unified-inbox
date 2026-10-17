import { type } from "arktype";
import { ConversationState, type Service } from "@inbox/shared/schema";
import { DbClient } from "./client.ts";
import type { DbRow } from "./protocol.ts";
import { conversationKey, type ChangedConversation } from "../lib/sync.ts";

/** One conversation as the list renders it: everything but the messages. */
export type ConversationRow = {
  key: string;
  artifactId: string;
  version: number;
  service: Service;
  name: string;
  isGroup: boolean;
  lastMessageAt: string;
  unread: boolean;
  unreadCount: number;
  preview: string;
  workspaceName: string | undefined;
  link: ConversationState["link"];
  conversationId: string;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversation(
     key TEXT PRIMARY KEY,
     artifact_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     service TEXT NOT NULL,
     name TEXT NOT NULL,
     is_group INTEGER NOT NULL,
     last_message_at TEXT NOT NULL,
     unread INTEGER NOT NULL,
     unread_count INTEGER NOT NULL,
     preview TEXT NOT NULL,
     state_json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS conversation_by_artifact ON conversation(artifact_id)`,
  `CREATE INDEX IF NOT EXISTS conversation_by_time ON conversation(last_message_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(key UNINDEXED, name, body)`,
  `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

const ROW_COLUMNS = `key, artifact_id, version, service, name, is_group, last_message_at, unread, unread_count, preview,
  json_extract(state_json, '$.workspaceName') AS workspace_name,
  json_extract(state_json, '$.link') AS link_json,
  json_extract(state_json, '$.conversationId') AS conversation_id`;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function rowFrom(r: DbRow): ConversationRow {
  const linkRaw = str(r.link_json);
  const link = (linkRaw ? JSON.parse(linkRaw) : {}) as ConversationState["link"];
  return {
    key: str(r.key),
    artifactId: str(r.artifact_id),
    version: Number(r.version),
    service: str(r.service) as Service,
    name: str(r.name),
    isGroup: Number(r.is_group) === 1,
    lastMessageAt: str(r.last_message_at),
    unread: Number(r.unread) === 1,
    unreadCount: Number(r.unread_count),
    preview: str(r.preview),
    workspaceName: r.workspace_name === null || r.workspace_name === undefined ? undefined : str(r.workspace_name),
    link,
    conversationId: str(r.conversation_id),
  };
}

/** Turns free text into an FTS5 prefix query, one quoted token per word. */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

/**
 * The viewer's local copy of the inbox (FR-16, FR-21): conversations as the
 * hub last sealed them, plus a full-text index over names and message bodies
 * for search. SQLite in a worker on OPFS; see worker.ts.
 */
export class ConversationCache {
  private constructor(private readonly db: DbClient) {}

  static async open(filename = "/unified-inbox.sqlite3"): Promise<ConversationCache> {
    const db = new DbClient();
    await db.open(filename);
    await db.exec(SCHEMA.map((sql) => ({ sql })));
    return new ConversationCache(db);
  }

  async knownVersions(): Promise<Map<string, number>> {
    const rows = await this.db.query("SELECT artifact_id, version FROM conversation");
    return new Map(rows.map((r) => [str(r.artifact_id), Number(r.version)]));
  }

  async upsertAll(changes: readonly ChangedConversation[]): Promise<void> {
    if (changes.length === 0) return;
    const statements: Array<{ sql: string; params: Array<string | number | null> }> = [];
    for (const c of changes) {
      const key = conversationKey(c.state);
      const bodies = c.state.messages.map((m) => m.body).join("\n");
      statements.push({
        sql: `INSERT INTO conversation(key, artifact_id, version, service, name, is_group, last_message_at, unread, unread_count, preview, state_json)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET artifact_id=excluded.artifact_id, version=excluded.version, service=excluded.service, name=excluded.name,
                is_group=excluded.is_group, last_message_at=excluded.last_message_at, unread=excluded.unread, unread_count=excluded.unread_count,
                preview=excluded.preview, state_json=excluded.state_json`,
        params: [
          key,
          c.artifactId,
          c.version,
          c.state.service,
          c.state.name,
          c.state.isGroup ? 1 : 0,
          c.state.lastMessageAt,
          c.state.unread ? 1 : 0,
          c.state.unreadCount,
          c.state.preview,
          JSON.stringify(c.state),
        ],
      });
      statements.push({ sql: "DELETE FROM conversation_fts WHERE key = ?", params: [key] });
      statements.push({ sql: "INSERT INTO conversation_fts(key, name, body) VALUES(?,?,?)", params: [key, c.state.name, bodies] });
    }
    await this.db.exec(statements);
  }

  async list(): Promise<ConversationRow[]> {
    const rows = await this.db.query(`SELECT ${ROW_COLUMNS} FROM conversation ORDER BY last_message_at DESC, key ASC`);
    return rows.map(rowFrom);
  }

  /** Search across names and message bodies (FR-21); results newest first. */
  async search(text: string): Promise<ConversationRow[]> {
    const q = ftsQuery(text);
    if (!q) return this.list();
    const rows = await this.db.query(
      `SELECT ${ROW_COLUMNS} FROM conversation WHERE key IN (SELECT key FROM conversation_fts WHERE conversation_fts MATCH ?) ORDER BY last_message_at DESC, key ASC`,
      [q],
    );
    return rows.map(rowFrom);
  }

  async state(key: string): Promise<ConversationState | null> {
    const rows = await this.db.query("SELECT state_json FROM conversation WHERE key = ?", [key]);
    const raw = rows[0]?.state_json;
    if (typeof raw !== "string") return null;
    const parsed = ConversationState(JSON.parse(raw));
    if (parsed instanceof type.errors) throw new Error(`Cached conversation ${key} is not valid: ${parsed.summary}`);
    return parsed;
  }

  async setUnread(keys: readonly string[], unread: boolean): Promise<void> {
    if (keys.length === 0) return;
    const flag = unread ? "true" : "false";
    await this.db.exec(
      keys.map((key) => ({
        sql: `UPDATE conversation SET unread = ?, unread_count = CASE WHEN ? THEN MAX(unread_count, 1) ELSE 0 END,
              state_json = json_set(state_json, '$.unread', json('${flag}'), '$.unreadCount', CASE WHEN ? THEN MAX(unread_count, 1) ELSE 0 END)
              WHERE key = ?`,
        params: [unread ? 1 : 0, unread ? 1 : 0, unread ? 1 : 0, key],
      })),
    );
  }

  async markAllRead(): Promise<void> {
    await this.db.exec([{ sql: "UPDATE conversation SET unread = 0, unread_count = 0, state_json = json_set(state_json, '$.unread', json('false'), '$.unreadCount', 0) WHERE unread = 1" }]);
  }

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.query("SELECT v FROM meta WHERE k = ?", [key]);
    const v = rows[0]?.v;
    return typeof v === "string" ? v : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.exec([{ sql: "INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params: [key, value] }]);
  }
}
