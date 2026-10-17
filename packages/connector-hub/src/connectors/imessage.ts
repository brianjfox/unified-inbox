import Database from "better-sqlite3";
import { statSync } from "node:fs";
import type { HubStatus, InboxEvent } from "@inbox/shared/schema";
import type { HubConfig } from "../config.ts";
import type { HubStore } from "../store.ts";
import type { ConnectorHost, IMessageConnector, Logger } from "./types.ts";
import { ReadBackUnavailableError } from "./types.ts";
import { decodeAttributedBody } from "./imessage/attributed-body.ts";

/**
 * The iMessage connector (FR-2, FR-6, FR-8; build-plan task 6).
 *
 * Reads the Messages database on this Mac read-only on a timer and hands
 * every new message to the hub as an InboxEvent. Messages owns the file, so
 * the connector never writes to it: read-back is the approved fallback
 * (ADR-6, QUESTIONS.md item 3) and markRead throws ReadBackUnavailableError.
 *
 * Every failure to read is a status on the Connections card, never a crash
 * of the hub (NFR-8): a missing Full Disk Access grant maps to
 * "no-full-disk-access", a missing file to "unavailable", a column the
 * current macOS no longer has to "error" naming the column. Each poll
 * retries from scratch, so granting access or fixing the path needs no
 * restart.
 */

export const IMESSAGE_CURSOR_KEY = "imessage:last-rowid";
/** On the very first run, start from messages this recent instead of the beginning of time. */
export const SEED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Rows per query while draining; the loop continues until a batch comes back short. */
export const BATCH_SIZE = 500;

/** Milliseconds between the Unix epoch and Apple's 2001-01-01 reference date. */
const APPLE_EPOCH_MS = 978_307_200_000;
/** Messages dates below this are seconds since 2001 (pre-High Sierra); above, nanoseconds. */
const SECONDS_FORM_LIMIT = 1e12;
const STYLE_GROUP = 43;
const STYLE_ONE_TO_ONE = 45;
/** Tapbacks (reactions) are stored as messages with associated_message_type 2000–2005 (added) and 3000–3005 (removed). */
const TAPBACK_MIN = 2000;
const TAPBACK_MAX = 3999;
/** The object-replacement character Messages puts in `text` where an attachment sits. */
const ATTACHMENT_PLACEHOLDER = /￼/g;

/** The subset of the Messages schema the connector queries; checked after every open (macOS-update risk). */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  message: ["ROWID", "guid", "text", "attributedBody", "date", "is_from_me", "handle_id", "item_type", "cache_has_attachments", "associated_message_type"],
  chat: ["ROWID", "guid", "chat_identifier", "display_name", "style"],
  handle: ["ROWID", "id", "service"],
  chat_message_join: ["chat_id", "message_id"],
  chat_handle_join: ["chat_id", "handle_id"],
};

type IMessageStatus = HubStatus["imessage"];
type IMessageState = IMessageStatus["state"];

type MessageRow = {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  date: number | null;
  is_from_me: number | null;
  item_type: number | null;
  cache_has_attachments: number | null;
  associated_message_type: number | null;
  chat_rowid: number | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  display_name: string | null;
  style: number | null;
  sender_handle: string | null;
};

type Statements = {
  batch: Database.Statement<[number], MessageRow>;
  seedCursor: Database.Statement<[number], { cursor: number | null }>;
  participants: Database.Statement<[number], { id: string }>;
};

export class SchemaMismatchError extends Error {}

export function createIMessageConnector(deps: { host: ConnectorHost; store: HubStore; config: HubConfig; log: Logger }): IMessageConnector {
  return new IMessageConnectorImpl(deps.host, deps.store, deps.config, deps.log);
}

class IMessageConnectorImpl implements IMessageConnector {
  readonly service = "imessage" as const;

  private db: Database.Database | null = null;
  private statements: Statements | null = null;
  private running = false;
  private paused = false;
  private timer: NodeJS.Timeout | null = null;
  private state: IMessageState = "unavailable";
  private detail = "Not started.";
  /** The detail before the "since" suffix, for change detection. */
  private baseDetail = "Not started.";
  private stateSince = new Date().toISOString();

  private readonly host: ConnectorHost;
  private readonly store: HubStore;
  private readonly config: HubConfig;
  private readonly log: Logger;

  constructor(host: ConnectorHost, store: HubStore, config: HubConfig, log: Logger) {
    this.host = host;
    this.store = store;
    this.config = config;
    this.log = log;
  }

  status(): IMessageStatus {
    return { state: this.state, detail: this.detail, readBack: "unavailable" };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info("starting", { dbPath: this.config.imessageDbPath, pollMs: this.config.imessagePollMs });
    if (this.paused) {
      this.setStatus("paused", pausedDetail());
      return;
    }
    // The first poll runs before start() resolves so the hub's first heartbeat carries a real state.
    this.runPoll();
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearTimer();
    this.closeDb();
    this.log.info("stopped");
  }

  async setPaused(paused: boolean): Promise<void> {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.clearTimer();
      this.closeDb();
      this.setStatus("paused", pausedDetail());
      this.log.info("paused");
      return;
    }
    this.log.info("resumed");
    if (!this.running) return;
    this.runPoll();
    this.scheduleNext();
  }

  async markRead(conversationId: string): Promise<void> {
    throw new ReadBackUnavailableError(
      `iMessage conversation ${conversationId} is marked read in the unified inbox and on every machine, but not in Messages: ` +
        "Messages scripting exposes no mark-read verb, and writing to chat.db while Messages owns the file is unsafe. " +
        "The Messages badge is left as it is (ADR-6 fallback, QUESTIONS.md item 3).",
    );
  }

  // ---- poll loop ---------------------------------------------------------

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.running || this.paused) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runPoll();
      this.scheduleNext();
    }, this.config.imessagePollMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One poll; never throws. Every failure becomes a status. poll() is synchronous, so polls cannot overlap. */
  private runPoll(): void {
    try {
      this.poll();
    } catch (err) {
      this.reportFailure(err);
    }
  }

  private poll(): void {
    if (!this.running || this.paused) return;
    const statements = this.statements ?? this.open();
    this.setStatus("connected", `Reading ${this.config.imessageDbPath} every ${Math.round(this.config.imessagePollMs / 1000)}s. Read-back is unavailable: opening a conversation marks it read here and on every machine, not in Messages.`);

    let cursor = this.readCursor(statements);
    const participantsByChat = new Map<number, string[]>();
    let emitted = 0;
    for (;;) {
      const rows = statements.batch.all(cursor);
      if (rows.length === 0) break;
      let lastMessageRowid = -1;
      for (const row of rows) {
        if (row.rowid === lastMessageRowid) continue; // a message joined to two chats: keep the first
        lastMessageRowid = row.rowid;
        const event = this.toEvent(row, statements, participantsByChat);
        if (event) {
          this.host.onMessage(event);
          emitted++;
        }
      }
      cursor = rows[rows.length - 1]!.rowid;
      this.store.setKv(IMESSAGE_CURSOR_KEY, String(cursor));
      if (rows.length < BATCH_SIZE) break;
    }
    if (emitted > 0) this.log.info("messages read", { count: emitted, cursor });
  }

  private readCursor(statements: Statements): number {
    const stored = this.store.getKv(IMESSAGE_CURSOR_KEY);
    if (stored !== null) {
      const n = Number(stored);
      if (!Number.isFinite(n)) throw new Error(`Stored cursor ${IMESSAGE_CURSOR_KEY} is not a number: ${stored}`);
      return n;
    }
    // First run: begin just before the oldest message inside the seed window, or after the newest message when none is that recent.
    const cutoffNs = (Date.now() - SEED_WINDOW_MS - APPLE_EPOCH_MS) * 1e6;
    const cursor = statements.seedCursor.get(cutoffNs)?.cursor ?? 0;
    this.store.setKv(IMESSAGE_CURSOR_KEY, String(cursor));
    this.log.info("first run: seeded cursor", { cursor, seedWindowDays: SEED_WINDOW_MS / 86_400_000 });
    return cursor;
  }

  private toEvent(row: MessageRow, statements: Statements, participantsByChat: Map<number, string[]>): InboxEvent | null {
    if (row.chat_rowid === null || row.chat_guid === null) return null; // belongs to no chat
    if ((row.item_type ?? 0) !== 0) return null; // group rename, join, leave, …
    const assoc = row.associated_message_type ?? 0;
    if (assoc >= TAPBACK_MIN && assoc <= TAPBACK_MAX) return null; // reaction, not a message

    const body = bodyOf(row);
    if (body === null) return null;

    let participants = participantsByChat.get(row.chat_rowid);
    if (!participants) {
      participants = statements.participants.all(row.chat_rowid).map((h) => h.id);
      participantsByChat.set(row.chat_rowid, participants);
    }
    const isGroup = row.style === STYLE_GROUP || (row.style !== STYLE_ONE_TO_ONE && participants.length > 1);
    const conversationName = conversationNameOf(row, participants, isGroup);
    const senderIsMe = (row.is_from_me ?? 0) !== 0;
    const senderName = senderIsMe ? "Me" : (row.sender_handle ?? row.chat_identifier ?? conversationName);

    return {
      v: 1,
      service: "imessage",
      conversationId: row.chat_guid,
      conversationName,
      isGroup,
      messageId: row.guid,
      senderName,
      senderIsMe,
      body,
      sentAt: appleDateToIso(row.date ?? 0),
      link: { imessage: { handles: participants, chatGuid: row.chat_guid } },
    };
  }

  // ---- database ----------------------------------------------------------

  private open(): Statements {
    const path = this.config.imessageDbPath;
    statSync(path); // ENOENT → unavailable; EPERM/EACCES → no Full Disk Access (see reportFailure)
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      checkSchema(db);
      const statements: Statements = {
        batch: db.prepare(
          `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.item_type,
                  m.cache_has_attachments, m.associated_message_type,
                  c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.style,
                  h.id AS sender_handle
           FROM message m
           LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = j.chat_id
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           WHERE m.ROWID > ?
           ORDER BY m.ROWID ASC, c.ROWID ASC
           LIMIT ${BATCH_SIZE}`,
        ),
        seedCursor: db.prepare(
          `SELECT COALESCE(
             (SELECT MIN(ROWID) - 1 FROM message
              WHERE (CASE WHEN date < ${SECONDS_FORM_LIMIT} THEN date * 1000000000 ELSE date END) >= ?),
             (SELECT MAX(ROWID) FROM message),
             0) AS cursor`,
        ),
        participants: db.prepare(
          `SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id = ? ORDER BY h.ROWID ASC`,
        ),
      };
      // Touch the file now: SQLite opens lazily, and a denied read surfaces here rather than in the constructor.
      statements.seedCursor.get(0);
      this.db = db;
      this.statements = statements;
      return statements;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  private closeDb(): void {
    this.statements = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Maps a failed open or poll to a card state; the next poll retries from scratch. */
  private reportFailure(err: unknown): void {
    this.closeDb();
    const path = this.config.imessageDbPath;
    const code = errorCode(err);
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof SchemaMismatchError) {
      this.setStatus("error", `${message} The Messages database on this Mac does not match the schema the hub knows; a macOS update may have changed it. Messages are not being read until the hub is updated.`);
    } else if (code === "ENOENT") {
      this.setStatus("unavailable", `Messages database not found at ${path}. Sign in to Messages on this Mac, or set HUB_IMESSAGE_DB to the path of chat.db.`);
    } else if (code === "EPERM" || code === "EACCES" || code === "SQLITE_CANTOPEN" || code === "SQLITE_AUTH" || /authorization denied/i.test(message)) {
      this.setStatus(
        "no-full-disk-access",
        `Full Disk Access is required to read ${path}. Open System Settings → Privacy & Security → Full Disk Access and add the hub's runtime, ${process.execPath} (the node binary that runs the hub), then restart the hub. ` +
          `The hub retries every ${Math.round(this.config.imessagePollMs / 1000)}s, so if access takes effect at once no restart is needed.`,
      );
    } else {
      this.setStatus("error", `Reading ${path} failed: ${message}`);
    }
    if (this.state === "error") this.log.error("poll failed", { error: message, code });
    else this.log.warn("poll failed", { state: this.state, error: message, code });
  }

  private setStatus(state: IMessageState, detail: string): void {
    if (state === this.state && detail === this.baseDetail) return;
    if (state !== this.state) this.stateSince = new Date().toISOString();
    this.state = state;
    this.baseDetail = detail;
    this.detail = state === "connected" ? detail : `${detail} (since ${this.stateSince})`;
    this.host.onStatusChanged();
  }
}

// ---- helpers --------------------------------------------------------------

function pausedDetail(): string {
  return "Paused from the Connections screen; new iMessages are not being read.";
}

function checkSchema(db: Database.Database): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (info.length === 0) throw new SchemaMismatchError(`Messages database has no table "${table}".`);
    const have = new Set(info.map((c) => c.name));
    for (const column of columns) {
      if (!have.has(column)) throw new SchemaMismatchError(`Messages database table "${table}" has no column "${column}".`);
    }
  }
}

function bodyOf(row: MessageRow): string | null {
  const raw = row.text ?? decodeAttributedBody(row.attributedBody);
  const text = raw === null ? "" : raw.replace(ATTACHMENT_PLACEHOLDER, "").trim();
  if (text.length > 0) return text;
  if ((row.cache_has_attachments ?? 0) !== 0) return "[attachment]";
  return null;
}

function conversationNameOf(row: MessageRow, participants: string[], isGroup: boolean): string {
  const display = row.display_name?.trim();
  if (display) return display;
  if (!isGroup) return participants[0] ?? row.chat_identifier ?? row.chat_guid ?? "";
  if (participants.length > 0) return participants.join(", ");
  return row.chat_identifier ?? row.chat_guid ?? "";
}

/** Messages stores dates as nanoseconds since 2001-01-01 (seconds on macOS before High Sierra). */
export function appleDateToIso(date: number): string {
  const seconds = date < SECONDS_FORM_LIMIT ? date : date / 1e9;
  return new Date(APPLE_EPOCH_MS + Math.round(seconds * 1000)).toISOString();
}

function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return null;
}
