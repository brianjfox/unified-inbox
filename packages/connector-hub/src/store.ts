import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationState, Service, StoredMessage } from "@inbox/shared/schema";
import { MESSAGES_PER_CONVERSATION } from "@inbox/shared/schema";

/**
 * The hub's local state: every conversation it has normalized, the relay
 * artifact that mirrors it, and small bookkeeping tables. Credentials are
 * not here; they are in the keychain. The WhatsApp session is here only in
 * encrypted form (see connectors/whatsapp.ts).
 */
export type ConversationRow = {
  key: string;
  service: Service;
  conversation_id: string;
  artifact_id: string | null;
  artifact_version: number;
  state_json: string;
  dirty: number;
  updated_at: string;
};

export function conversationKey(service: Service, conversationId: string): string {
  return `${service}:${conversationId}`;
}

export class HubStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation (
        key TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        artifact_id TEXT,
        artifact_version INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_dirty ON conversation(dirty);
      CREATE TABLE IF NOT EXISTS seen_message (
        key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (key, message_id)
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_event (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_state (
        state TEXT PRIMARY KEY,
        viewer_device_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_workspace (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        team_domain TEXT,
        user_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS whatsapp_auth (
        k TEXT PRIMARY KEY,
        v BLOB NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getKv(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return row?.v ?? null;
  }
  setKv(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  deleteKv(k: string): void {
    this.db.prepare("DELETE FROM kv WHERE k = ?").run(k);
  }

  getConversation(service: Service, conversationId: string): { row: ConversationRow; state: ConversationState } | null {
    const row = this.db.prepare("SELECT * FROM conversation WHERE key = ?").get(conversationKey(service, conversationId)) as ConversationRow | undefined;
    if (!row) return null;
    return { row, state: JSON.parse(row.state_json) as ConversationState };
  }

  allConversations(): Array<{ row: ConversationRow; state: ConversationState }> {
    const rows = this.db.prepare("SELECT * FROM conversation ORDER BY updated_at DESC").all() as ConversationRow[];
    return rows.map((row) => ({ row, state: JSON.parse(row.state_json) as ConversationState }));
  }

  dirtyConversations(): Array<{ row: ConversationRow; state: ConversationState }> {
    const rows = this.db.prepare("SELECT * FROM conversation WHERE dirty = 1 ORDER BY updated_at ASC").all() as ConversationRow[];
    return rows.map((row) => ({ row, state: JSON.parse(row.state_json) as ConversationState }));
  }

  /** Writes a conversation's state and marks it for upload. */
  putConversation(state: ConversationState): void {
    const key = conversationKey(state.service, state.conversationId);
    this.db
      .prepare(
        `INSERT INTO conversation(key, service, conversation_id, state_json, dirty, updated_at)
         VALUES(?, ?, ?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET state_json = excluded.state_json, dirty = 1, updated_at = excluded.updated_at`,
      )
      .run(key, state.service, state.conversationId, JSON.stringify(state), new Date().toISOString());
  }

  markUploaded(key: string, artifactId: string, version: number): void {
    this.db
      .prepare("UPDATE conversation SET artifact_id = ?, artifact_version = ?, dirty = CASE WHEN artifact_version = ? THEN dirty ELSE dirty END WHERE key = ?")
      .run(artifactId, version, version, key);
    // Clear dirty only if nothing changed since the upload began: compare state hash via updated_at is overkill here;
    // the uploader re-reads the row after upload and calls clearDirtyIfUnchanged.
  }

  clearDirtyIfUnchanged(key: string, updatedAtSeen: string): void {
    this.db.prepare("UPDATE conversation SET dirty = 0 WHERE key = ? AND updated_at = ?").run(key, updatedAtSeen);
  }

  hasSeenMessage(key: string, messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM seen_message WHERE key = ? AND message_id = ?").get(key, messageId);
  }
  rememberMessage(key: string, messageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO seen_message(key, message_id) VALUES(?, ?)").run(key, messageId);
  }

  hasProcessedEvent(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed_event WHERE id = ?").get(id);
  }
  rememberEvent(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO processed_event(id, at) VALUES(?, ?)").run(id, new Date().toISOString());
  }

  putOauthState(state: string, viewerDeviceId: string, redirectUri: string): void {
    this.db.prepare("INSERT INTO oauth_state(state, viewer_device_id, redirect_uri, created_at) VALUES(?, ?, ?, ?)").run(state, viewerDeviceId, redirectUri, new Date().toISOString());
  }
  /** Returns and deletes the state (single use). */
  takeOauthState(state: string): { viewer_device_id: string; redirect_uri: string; created_at: string } | null {
    const row = this.db.prepare("SELECT viewer_device_id, redirect_uri, created_at FROM oauth_state WHERE state = ?").get(state) as
      | { viewer_device_id: string; redirect_uri: string; created_at: string }
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM oauth_state WHERE state = ?").run(state);
    return row;
  }
  pruneOauthStates(olderThanMs: number): void {
    this.db.prepare("DELETE FROM oauth_state WHERE created_at < ?").run(new Date(Date.now() - olderThanMs).toISOString());
  }

  slackWorkspaces(): Array<{ team_id: string; name: string; team_domain: string | null; user_id: string; authorized_at: string }> {
    return this.db.prepare("SELECT * FROM slack_workspace ORDER BY authorized_at ASC").all() as never;
  }
  putSlackWorkspace(w: { teamId: string; name: string; teamDomain: string | null; userId: string }): void {
    this.db
      .prepare(
        `INSERT INTO slack_workspace(team_id, name, team_domain, user_id, authorized_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, team_domain = excluded.team_domain, user_id = excluded.user_id, authorized_at = excluded.authorized_at`,
      )
      .run(w.teamId, w.name, w.teamDomain, w.userId, new Date().toISOString());
  }
  deleteSlackWorkspace(teamId: string): void {
    this.db.prepare("DELETE FROM slack_workspace WHERE team_id = ?").run(teamId);
  }

  whatsappAuthGet(k: string): Uint8Array | null {
    const row = this.db.prepare("SELECT v FROM whatsapp_auth WHERE k = ?").get(k) as { v: Buffer } | undefined;
    return row ? new Uint8Array(row.v) : null;
  }
  whatsappAuthSet(k: string, v: Uint8Array): void {
    this.db.prepare("INSERT INTO whatsapp_auth(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, Buffer.from(v));
  }
  whatsappAuthDelete(k: string): void {
    this.db.prepare("DELETE FROM whatsapp_auth WHERE k = ?").run(k);
  }
  whatsappAuthClear(): void {
    this.db.prepare("DELETE FROM whatsapp_auth").run();
  }
  whatsappAuthKeys(prefix: string): string[] {
    return (this.db.prepare("SELECT k FROM whatsapp_auth WHERE k LIKE ?").all(`${prefix}%`) as Array<{ k: string }>).map((r) => r.k);
  }
}

/** Append a message to a conversation's state, keeping the cap and order. Returns false when already present. */
export function appendMessage(state: ConversationState, msg: StoredMessage): boolean {
  if (state.messages.some((m) => m.id === msg.id)) return false;
  state.messages.push(msg);
  state.messages.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  if (state.messages.length > MESSAGES_PER_CONVERSATION) state.messages.splice(0, state.messages.length - MESSAGES_PER_CONVERSATION);
  const last = state.messages[state.messages.length - 1]!;
  if (last.sentAt > state.lastMessageAt) state.lastMessageAt = last.sentAt;
  return true;
}
