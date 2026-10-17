import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxEvent } from "@inbox/shared/schema";
import { HubStore } from "../src/store.ts";
import type { HubConfig } from "../src/config.ts";
import type { ConnectorHost, Logger } from "../src/connectors/types.ts";
import { ReadBackUnavailableError } from "../src/connectors/types.ts";
import { createIMessageConnector, IMESSAGE_CURSOR_KEY, appleDateToIso } from "../src/connectors/imessage.ts";
import { decodeAttributedBody } from "../src/connectors/imessage/attributed-body.ts";

// ---- fixtures ---------------------------------------------------------------

const APPLE_EPOCH_MS = 978_307_200_000;
const DAY_MS = 86_400_000;
const POLL_MS = 20;

const tempRoot = mkdtempSync(join(tmpdir(), "imessage-test-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

/** Nanoseconds since 2001-01-01, as Messages stores dates on modern macOS. Exact through BigInt. */
function appleNs(ms: number): bigint {
  return BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
}
/** Seconds since 2001-01-01, the pre-High Sierra form. */
function appleSeconds(ms: number): number {
  return Math.floor((ms - APPLE_EPOCH_MS) / 1000);
}

/** The subset of the Messages schema the connector queries: same table and column names and types as chat.db. */
const SCHEMA = `
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT, service_name TEXT, room_name TEXT, display_name TEXT);
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, attributedBody BLOB);
  CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat(ROWID), handle_id INTEGER REFERENCES handle(ROWID), UNIQUE(chat_id, handle_id));
  CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat(ROWID), message_id INTEGER REFERENCES message(ROWID), message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
`;

/** Builds an attributedBody blob the way Messages lays it out: "NSString", the 01 94 84 01 2B marker, a length, UTF-8 bytes, trailing archive bytes. */
function typedstreamBlob(text: string, options: { forceWideLength?: boolean } = {}): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  let length: Buffer;
  if (options.forceWideLength || utf8.length >= 0x80) {
    length = Buffer.alloc(3);
    length[0] = 0x81;
    length.writeUInt16LE(utf8.length, 1);
  } else {
    length = Buffer.from([utf8.length]);
  }
  return Buffer.concat([
    Buffer.from("040b73747265616d747970656481e803840140848484124e534174747269627574656453747269", "hex"), // streamtyped … NSAttributedString prefix
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    length,
    utf8,
    Buffer.from("8684026949" + "01" + "92848484" + "0c4e5344696374696f6e617279", "hex"), // trailing NSDictionary attributes
  ]);
}

type Fixture = {
  dbPath: string;
  db: Database.Database;
  insertMessage(m: {
    guid: string;
    text?: string | null;
    attributedBody?: Buffer | null;
    date?: bigint | number;
    fromMe?: boolean;
    handleId?: number;
    itemType?: number;
    hasAttachments?: boolean;
    associatedType?: number;
    chatId?: number | null;
  }): number;
  chats: { alice: number; group: number };
  handles: { alice: string; bob: string; carol: string };
};

function buildFixture(name: string): Fixture {
  const dir = mkdtempSync(join(tempRoot, name + "-"));
  const dbPath = join(dir, "chat.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const handles = { alice: "+15550100001", bob: "bob@example.com", carol: "+15550100003" };
  const insertHandle = db.prepare("INSERT INTO handle(id, service) VALUES(?, ?)");
  const aliceId = Number(insertHandle.run(handles.alice, "iMessage").lastInsertRowid);
  const bobId = Number(insertHandle.run(handles.bob, "iMessage").lastInsertRowid);
  const carolId = Number(insertHandle.run(handles.carol, "SMS").lastInsertRowid);

  const insertChat = db.prepare("INSERT INTO chat(guid, style, chat_identifier, display_name, service_name) VALUES(?, ?, ?, ?, ?)");
  const aliceChat = Number(insertChat.run("iMessage;-;+15550100001", 45, "+15550100001", null, "iMessage").lastInsertRowid);
  const groupChat = Number(insertChat.run("iMessage;+;chat123456789", 43, "chat123456789", "Weekend plans", "iMessage").lastInsertRowid);
  const insertChatHandle = db.prepare("INSERT INTO chat_handle_join(chat_id, handle_id) VALUES(?, ?)");
  insertChatHandle.run(aliceChat, aliceId);
  insertChatHandle.run(groupChat, bobId);
  insertChatHandle.run(groupChat, carolId);

  const insertMessage = db.prepare(
    "INSERT INTO message(guid, text, attributedBody, date, is_from_me, handle_id, item_type, cache_has_attachments, associated_message_type, service) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'iMessage')",
  );
  const insertJoin = db.prepare("INSERT INTO chat_message_join(chat_id, message_id, message_date) VALUES(?, ?, ?)");

  const fixture: Fixture = {
    dbPath,
    db,
    chats: { alice: aliceChat, group: groupChat },
    handles,
    insertMessage(m) {
      const date = m.date ?? appleNs(Date.now());
      const handleId = m.handleId ?? (m.chatId === groupChat ? bobId : aliceId);
      const rowid = Number(
        insertMessage.run(
          m.guid,
          m.text === undefined ? null : m.text,
          m.attributedBody ?? null,
          date,
          m.fromMe ? 1 : 0,
          m.fromMe ? 0 : handleId,
          m.itemType ?? 0,
          m.hasAttachments ? 1 : 0,
          m.associatedType ?? 0,
        ).lastInsertRowid,
      );
      const chatId = m.chatId === undefined ? aliceChat : m.chatId;
      if (chatId !== null) insertJoin.run(chatId, rowid, date);
      return rowid;
    },
  };
  return fixture;
}

/** Fills a fixture with the scenario the connector tests drive. Returns the rowid of the first message inside the window. */
function seedScenario(f: Fixture): void {
  const now = Date.now();
  // 1. Old message outside the 14-day window: skipped on first run.
  f.insertMessage({ guid: "old-1", text: "ancient history", date: appleNs(now - 20 * DAY_MS), chatId: f.chats.alice });
  // 2. One-to-one text from the other party.
  f.insertMessage({ guid: "m-1", text: "Hi, are you around?", date: appleNs(now - 5 * DAY_MS), chatId: f.chats.alice });
  // 3. From me, with the older seconds-since-2001 date form.
  f.insertMessage({ guid: "m-2", text: "Yes, what's up?", date: appleSeconds(now - 4 * DAY_MS), fromMe: true, chatId: f.chats.alice });
  // 4. Group message from bob.
  f.insertMessage({ guid: "m-3", text: "Who is in for Saturday?", date: appleNs(now - 3 * DAY_MS), chatId: f.chats.group });
  // 5. NULL text, body only in attributedBody.
  f.insertMessage({ guid: "m-4", text: null, attributedBody: typedstreamBlob("Decoded from the archive — ünïcödé too"), date: appleNs(now - 2 * DAY_MS), chatId: f.chats.alice });
  // 6. Group rename: item_type != 0, skipped.
  f.insertMessage({ guid: "rename-1", text: null, itemType: 2, date: appleNs(now - 2 * DAY_MS + 1000), chatId: f.chats.group });
  // 7. Attachment-only message: text is the object-replacement character, attributedBody absent.
  f.insertMessage({ guid: "m-5", text: "￼", hasAttachments: true, date: appleNs(now - 1 * DAY_MS), chatId: f.chats.group });
  // 8. Empty message without attachment: skipped.
  f.insertMessage({ guid: "empty-1", text: "", date: appleNs(now - 1 * DAY_MS + 1000), chatId: f.chats.alice });
  // 9. Message belonging to no chat: skipped.
  f.insertMessage({ guid: "orphan-1", text: "nobody's chat", date: appleNs(now - 1 * DAY_MS + 2000), chatId: null });
  // 10. Tapback (reaction): skipped.
  f.insertMessage({ guid: "tapback-1", text: "Loved “Who is in for Saturday?”", associatedType: 2000, date: appleNs(now - 1 * DAY_MS + 3000), chatId: f.chats.group });
}

// ---- fake host (the hub side of the contract) -------------------------------

type FakeHost = ConnectorHost & { events: InboxEvent[]; statusChanges: number };

const silentLog: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeHost(): FakeHost {
  const host: FakeHost = {
    events: [],
    statusChanges: 0,
    onMessage(event) {
      host.events.push(event);
    },
    onConversationRenamed() {},
    onStatusChanged() {
      host.statusChanges++;
    },
    log: silentLog,
  };
  return host;
}

function configFor(dbPath: string): HubConfig {
  return {
    relayUrl: "http://localhost:8787",
    tenantId: "test",
    hubLabel: "test-hub",
    dataDir: tempRoot,
    keychainService: "test",
    heartbeatMs: 30_000,
    mailboxPollMs: 3_000,
    imessagePollMs: POLL_MS,
    imessageDbPath: dbPath,
    version: "test",
  };
}

async function until(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- attributedBody decoder -------------------------------------------------

describe("attributedBody decoder", () => {
  test("decodes a short-length blob", () => {
    assert.equal(decodeAttributedBody(typedstreamBlob("hello there")), "hello there");
  });

  test("decodes multi-byte UTF-8 by byte length", () => {
    const text = "café ☕ 日本語";
    assert.equal(decodeAttributedBody(typedstreamBlob(text)), text);
  });

  test("decodes a 0x81 two-byte little-endian length", () => {
    const text = "x".repeat(300) + " end";
    const blob = typedstreamBlob(text);
    const markerAt = blob.indexOf(Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]));
    assert.equal(blob[markerAt + 5], 0x81, "fixture uses the wide length form");
    assert.equal(decodeAttributedBody(blob), text);
  });

  test("decodes a 0x81 length even for a short string", () => {
    assert.equal(decodeAttributedBody(typedstreamBlob("short", { forceWideLength: true })), "short");
  });

  test("yields no text for garbage, empty, or truncated blobs", () => {
    assert.equal(decodeAttributedBody(Buffer.from("this is not a typedstream at all")), null);
    assert.equal(decodeAttributedBody(Buffer.alloc(0)), null);
    assert.equal(decodeAttributedBody(null), null);
    const truncated = typedstreamBlob("a message that gets cut off").subarray(0, 60);
    assert.equal(decodeAttributedBody(truncated), null);
    // "NSString" present but no '+' marker follows.
    assert.equal(decodeAttributedBody(Buffer.concat([Buffer.from("NSString"), Buffer.alloc(16, 0)])), null);
    // Length points at bytes that are not UTF-8.
    const bad = Buffer.concat([Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x03, 0xff, 0xfe, 0xfd])]);
    assert.equal(decodeAttributedBody(bad), null);
  });
});

describe("date conversion", () => {
  test("nanoseconds and seconds since 2001 both map to the same instant", () => {
    const ms = Date.UTC(2026, 9, 16, 12, 30, 15);
    assert.equal(appleDateToIso(Number(appleNs(ms))), new Date(ms).toISOString());
    assert.equal(appleDateToIso(appleSeconds(ms)), new Date(ms).toISOString());
  });
});

// ---- connector against a fixture database -----------------------------------

describe("iMessage connector", () => {
  test("reads the seed window, then only new rows, with the cursor persisted", async () => {
    const f = buildFixture("flow");
    seedScenario(f);
    const host = fakeHost();
    const store = new HubStore(":memory:");
    const connector = createIMessageConnector({ host, store, config: configFor(f.dbPath), log: silentLog });

    assert.equal(connector.service, "imessage");
    assert.equal(connector.status().readBack, "unavailable");

    await connector.start();
    try {
      assert.equal(connector.status().state, "connected", connector.status().detail);
      assert.equal(host.statusChanges, 1, "one status change for the first connect");

      const ids = host.events.map((e) => e.messageId);
      assert.deepEqual(ids, ["m-1", "m-2", "m-3", "m-4", "m-5"], "ordered by ROWID; old, rename, empty, orphan and tapback rows skipped");

      const [m1, m2, m3, m4, m5] = host.events as [InboxEvent, InboxEvent, InboxEvent, InboxEvent, InboxEvent];

      // One-to-one from the other party.
      assert.equal(m1.service, "imessage");
      assert.equal(m1.conversationId, "iMessage;-;+15550100001");
      assert.equal(m1.conversationName, f.handles.alice, "no display name: the handle id names the conversation");
      assert.equal(m1.isGroup, false);
      assert.equal(m1.senderName, f.handles.alice);
      assert.equal(m1.senderIsMe, false);
      assert.equal(m1.body, "Hi, are you around?");
      assert.deepEqual(m1.link, { imessage: { handles: [f.handles.alice], chatGuid: "iMessage;-;+15550100001" } });
      assert.equal(m1.v, 1);

      // From me, seconds-form date.
      assert.equal(m2.senderName, "Me");
      assert.equal(m2.senderIsMe, true);
      const m2Age = Date.now() - Date.parse(m2.sentAt);
      assert.ok(m2Age > 3.9 * DAY_MS && m2Age < 4.1 * DAY_MS, `seconds-form date decoded: ${m2.sentAt}`);
      const m1Age = Date.now() - Date.parse(m1.sentAt);
      assert.ok(m1Age > 4.9 * DAY_MS && m1Age < 5.1 * DAY_MS, `nanosecond date decoded: ${m1.sentAt}`);

      // Group with display name and two participants.
      assert.equal(m3.conversationId, "iMessage;+;chat123456789");
      assert.equal(m3.conversationName, "Weekend plans");
      assert.equal(m3.isGroup, true);
      assert.equal(m3.senderName, f.handles.bob);
      assert.deepEqual(m3.link.imessage?.handles, [f.handles.bob, f.handles.carol]);

      // attributedBody decoded when text is NULL.
      assert.equal(m4.body, "Decoded from the archive — ünïcödé too");

      // Attachment-only message.
      assert.equal(m5.body, "[attachment]");
      assert.equal(m5.isGroup, true);

      // Cursor persisted at the last row scanned (the tapback is the last row).
      const lastRowid = (f.db.prepare("SELECT MAX(ROWID) AS r FROM message").get() as { r: number }).r;
      assert.equal(store.getKv(IMESSAGE_CURSOR_KEY), String(lastRowid));

      // A few more polls emit nothing.
      await sleep(POLL_MS * 5);
      assert.equal(host.events.length, 5, "no duplicates on later polls");
      assert.equal(host.statusChanges, 1, "status does not churn while connected");

      // A new row is emitted on the next poll.
      f.insertMessage({ guid: "m-6", text: "See you at 10", chatId: f.chats.alice });
      await until(() => host.events.length === 6, "the new message");
      assert.equal(host.events[5]!.messageId, "m-6");
      assert.equal(host.events[5]!.body, "See you at 10");
      assert.equal(store.getKv(IMESSAGE_CURSOR_KEY), String(lastRowid + 1));

      // Group without a display name is named after its participants.
      f.db.prepare("UPDATE chat SET display_name = NULL WHERE ROWID = ?").run(f.chats.group);
      f.insertMessage({ guid: "m-7", text: "Renamed away", chatId: f.chats.group });
      await until(() => host.events.length === 7, "the group message");
      assert.equal(host.events[6]!.conversationName, `${f.handles.bob}, ${f.handles.carol}`);
    } finally {
      await connector.stop();
      store.close();
      f.db.close();
    }
  });

  test("a restart resumes from the stored cursor instead of the seed window", async () => {
    const f = buildFixture("resume");
    seedScenario(f);
    const store = new HubStore(":memory:");
    const first = fakeHost();
    const c1 = createIMessageConnector({ host: first, store, config: configFor(f.dbPath), log: silentLog });
    await c1.start();
    await c1.stop();
    assert.equal(first.events.length, 5);

    f.insertMessage({ guid: "after-restart", text: "while the hub was down", chatId: f.chats.alice });
    const second = fakeHost();
    const c2 = createIMessageConnector({ host: second, store, config: configFor(f.dbPath), log: silentLog });
    await c2.start();
    await c2.stop();
    assert.deepEqual(
      second.events.map((e) => e.messageId),
      ["after-restart"],
    );
    store.close();
    f.db.close();
  });

  test("first run on a database with nothing recent emits nothing and starts after the newest row", async () => {
    const f = buildFixture("stale");
    f.insertMessage({ guid: "old-a", text: "a", date: appleNs(Date.now() - 30 * DAY_MS) });
    const last = f.insertMessage({ guid: "old-b", text: "b", date: appleNs(Date.now() - 20 * DAY_MS) });
    const store = new HubStore(":memory:");
    const host = fakeHost();
    const c = createIMessageConnector({ host, store, config: configFor(f.dbPath), log: silentLog });
    await c.start();
    await c.stop();
    assert.equal(host.events.length, 0);
    assert.equal(store.getKv(IMESSAGE_CURSOR_KEY), String(last));
    store.close();
    f.db.close();
  });

  test("markRead throws ReadBackUnavailableError and names the fallback", async () => {
    const f = buildFixture("markread");
    const store = new HubStore(":memory:");
    const c = createIMessageConnector({ host: fakeHost(), store, config: configFor(f.dbPath), log: silentLog });
    await assert.rejects(c.markRead("iMessage;-;+15550100001"), (err: unknown) => {
      assert.ok(err instanceof ReadBackUnavailableError);
      assert.match(err.message, /Messages badge/);
      assert.match(err.message, /QUESTIONS\.md item 3/);
      return true;
    });
    assert.equal(c.status().readBack, "unavailable");
    store.close();
    f.db.close();
  });

  test("setPaused stops polling and reports paused; resuming picks up what arrived meanwhile", async () => {
    const f = buildFixture("pause");
    seedScenario(f);
    const store = new HubStore(":memory:");
    const host = fakeHost();
    const c = createIMessageConnector({ host, store, config: configFor(f.dbPath), log: silentLog });
    await c.start();
    try {
      assert.equal(host.events.length, 5);
      await c.setPaused(true);
      assert.equal(c.status().state, "paused");
      assert.match(c.status().detail, /Paused/);
      assert.match(c.status().detail, /since \d{4}-/);
      assert.equal(host.statusChanges, 2);

      f.insertMessage({ guid: "while-paused", text: "not yet", chatId: f.chats.alice });
      await sleep(POLL_MS * 5);
      assert.equal(host.events.length, 5, "nothing read while paused");

      await c.setPaused(false);
      assert.equal(c.status().state, "connected");
      assert.equal(host.events.length, 6, "the message that arrived while paused is read on resume");
      assert.equal(host.events[5]!.messageId, "while-paused");
      assert.equal(host.statusChanges, 3);

      // Pausing twice is a no-op; stop() after pause is clean.
      await c.setPaused(true);
      await c.setPaused(true);
      assert.equal(host.statusChanges, 4);
    } finally {
      await c.stop();
      store.close();
      f.db.close();
    }
  });

  test("a missing database file is 'unavailable' and start() does not throw", async () => {
    const store = new HubStore(":memory:");
    const host = fakeHost();
    const path = join(tempRoot, "does-not-exist", "chat.db");
    const c = createIMessageConnector({ host, store, config: configFor(path), log: silentLog });
    await c.start();
    try {
      assert.equal(c.status().state, "unavailable");
      assert.match(c.status().detail, /not found/);
      assert.ok(c.status().detail.includes(path));
      assert.match(c.status().detail, /HUB_IMESSAGE_DB/);
      assert.equal(host.statusChanges, 1);
      await sleep(POLL_MS * 4);
      assert.equal(host.statusChanges, 1, "a repeated failure does not re-announce the status");
    } finally {
      await c.stop();
      store.close();
    }
  });

  test("a file the process may not open is 'no-full-disk-access' and recovers without a restart", { skip: process.getuid?.() === 0 ? "root can open anything" : false }, async () => {
    const f = buildFixture("fda-source");
    seedScenario(f);
    f.db.close();
    const dir = mkdtempSync(join(tempRoot, "fda-"));
    const locked = join(dir, "chat.db");
    copyFileSync(f.dbPath, locked);
    chmodSync(locked, 0o000);

    const store = new HubStore(":memory:");
    const host = fakeHost();
    const c = createIMessageConnector({ host, store, config: configFor(locked), log: silentLog });
    await c.start();
    try {
      assert.equal(c.status().state, "no-full-disk-access", c.status().detail);
      const detail = c.status().detail;
      assert.match(detail, /Full Disk Access/);
      assert.match(detail, /System Settings/);
      assert.ok(detail.includes(process.execPath), "names the node binary to add");
      assert.match(detail, /restart the hub/);
      assert.match(detail, /since \d{4}-/);
      assert.equal(host.events.length, 0);

      // Granting access: the next poll connects and reads, with no restart.
      chmodSync(locked, 0o600);
      await until(() => c.status().state === "connected", "recovery to connected");
      await until(() => host.events.length === 5, "messages after recovery");
      assert.equal(host.statusChanges, 2);
    } finally {
      await c.stop();
      store.close();
    }
  });

  test("a directory in place of the database is an 'error' naming the path", async () => {
    const dir = mkdtempSync(join(tempRoot, "dir-"));
    const store = new HubStore(":memory:");
    const host = fakeHost();
    const c = createIMessageConnector({ host, store, config: configFor(dir), log: silentLog });
    await c.start();
    try {
      assert.equal(c.status().state, "error", c.status().detail);
      assert.ok(c.status().detail.includes(dir));
    } finally {
      await c.stop();
      store.close();
    }
  });

  test("a schema without a column the connector needs is an 'error' naming the column", async () => {
    const dir = mkdtempSync(join(tempRoot, "schema-"));
    const path = join(dir, "chat.db");
    const db = new Database(path);
    db.exec(SCHEMA.replace(", attributedBody BLOB", ""));
    db.close();
    const store = new HubStore(":memory:");
    const host = fakeHost();
    const c = createIMessageConnector({ host, store, config: configFor(path), log: silentLog });
    await c.start();
    try {
      assert.equal(c.status().state, "error");
      assert.match(c.status().detail, /table "message" has no column "attributedBody"/);
      assert.match(c.status().detail, /macOS update/);
      assert.equal(host.events.length, 0);
    } finally {
      await c.stop();
      store.close();
    }
  });

  test("the connector never writes to the Messages database", async () => {
    const f = buildFixture("readonly");
    seedScenario(f);
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number };
    const store = new HubStore(":memory:");
    const c = createIMessageConnector({ host: fakeHost(), store, config: configFor(f.dbPath), log: silentLog });
    await c.start();
    await c.stop();
    const after = f.db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number };
    assert.equal(after.n, before.n);
    assert.equal((f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'kv'").get() as unknown) ?? null, null, "the cursor lives in the hub store, not in chat.db");
    store.close();
    f.db.close();
  });
});
