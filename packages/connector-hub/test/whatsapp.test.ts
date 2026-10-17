import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { initAuthCreds } from "@whiskeysockets/baileys";
import WAProto from "@whiskeysockets/baileys/WAProto/index.js";
import type { Service } from "@inbox/shared/schema";
import { HubStore } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import type { Keychain } from "../src/keychain.ts";
import type { ConnectorHost } from "../src/connectors/types.ts";
import { createWhatsAppConnector } from "../src/connectors/whatsapp.ts";
import {
  WHATSAPP_AUTH_KEYCHAIN_ITEM,
  WhatsAppAuthStateError,
  decryptRecord,
  encryptRecord,
  generateAuthKey,
  hasLinkedSession,
  useEncryptedSqliteAuthState,
} from "../src/connectors/whatsapp/auth-state.ts";
import {
  EXPIRED_DETAIL,
  LINKING_DETAIL,
  backoffMs,
  disconnectStatusCode,
  nextOnConnectionUpdate,
  type WhatsAppStatus,
} from "../src/connectors/whatsapp/lifecycle.ts";
import {
  extractBody,
  isGroupJid,
  jidDigits,
  jidPhone,
  shouldIgnoreJid,
  timestampToIso,
  timestampToSeconds,
  toInboxEvent,
  withinHistoryWindow,
  type WaMessage,
} from "../src/connectors/whatsapp/normalize.ts";

const bytes = (b: Uint8Array | Buffer | undefined | null): Buffer => Buffer.from(b ?? []);

// ---------------------------------------------------------------------------
// Encrypted auth state
// ---------------------------------------------------------------------------

describe("useEncryptedSqliteAuthState", () => {
  test("round-trips creds and key records, deletes on null, and hides plaintext", async () => {
    const store = new HubStore(":memory:");
    const key = await generateAuthKey();
    const { state, saveCreds } = await useEncryptedSqliteAuthState(store, key);

    assert.equal(hasLinkedSession(state.creds), false, "a fresh session is not linked");
    state.creds.me = { id: "15551234567:3@s.whatsapp.net", name: "Brian" };
    state.creds.registered = true;
    await saveCreds();
    assert.equal(hasLinkedSession(state.creds), true);

    const preKey1 = { public: Buffer.from("public-one-bytes"), private: Buffer.from("private-one-bytes") };
    const preKey2 = { public: Buffer.from("public-two-bytes"), private: Buffer.from("private-two-bytes") };
    const session = Buffer.from("plain session bytes that must not appear in the table");
    await state.keys.set({
      "pre-key": { "1": preKey1, "2": preKey2 },
      session: { "15551234567.0": session },
      "app-state-sync-key": {
        k1: { keyData: Buffer.from([1, 2, 3, 4]), fingerprint: { rawId: 7, currentIndex: 0, deviceIndexes: [0] }, timestamp: 42 },
      },
    });

    const preKeys = await state.keys.get("pre-key", ["1", "2", "3"]);
    assert.deepEqual(Object.keys(preKeys).sort(), ["1", "2"], "a missing id is simply absent");
    assert.ok(bytes(preKeys["1"]?.public).equals(preKey1.public));
    assert.ok(bytes(preKeys["1"]?.private).equals(preKey1.private));
    assert.ok(bytes(preKeys["2"]?.public).equals(preKey2.public));

    const sessions = await state.keys.get("session", ["15551234567.0"]);
    assert.ok(bytes(sessions["15551234567.0"]).equals(session));

    const appKeys = await state.keys.get("app-state-sync-key", ["k1"]);
    assert.ok(bytes(appKeys.k1?.keyData).equals(Buffer.from([1, 2, 3, 4])));
    assert.equal(appKeys.k1?.fingerprint?.rawId, 7);

    // set with null deletes the record.
    await state.keys.set({ "pre-key": { "1": null } });
    assert.deepEqual(Object.keys(await state.keys.get("pre-key", ["1", "2"])), ["2"]);
    assert.deepEqual(store.whatsappAuthKeys("pre-key-"), ["pre-key-2"]);

    // Nothing in the table is plaintext.
    const allRows = store.whatsappAuthKeys("");
    assert.ok(allRows.includes("creds") && allRows.includes("session-15551234567.0"));
    for (const row of allRows) {
      const raw = Buffer.from(store.whatsappAuthGet(row)!);
      const asText = raw.toString("latin1");
      assert.ok(!asText.includes("registered"), `${row} leaks a JSON field name`);
      assert.ok(!asText.includes("15551234567"), `${row} leaks the phone number`);
      assert.ok(!asText.includes(state.creds.advSecretKey), `${row} leaks advSecretKey`);
      assert.ok(!asText.includes(session.toString("base64")), `${row} leaks the session (base64)`);
      assert.ok(!asText.includes("plain session bytes"), `${row} leaks the session (raw)`);
      assert.ok(!raw.includes(preKey1.private) && !raw.includes(preKey2.private), `${row} leaks a private key`);
    }

    // Reopening with the same key yields the same creds.
    const reopened = await useEncryptedSqliteAuthState(store, key);
    assert.equal(reopened.state.creds.me?.id, "15551234567:3@s.whatsapp.net");
    assert.equal(reopened.state.creds.registered, true);
    assert.ok(bytes(reopened.state.creds.noiseKey.private).equals(bytes(state.creds.noiseKey.private)));
    assert.ok(bytes(reopened.state.creds.signedIdentityKey.public).equals(bytes(state.creds.signedIdentityKey.public)));
    assert.equal(reopened.state.creds.registrationId, state.creds.registrationId);
    const reopenedPreKeys = await reopened.state.keys.get("pre-key", ["2"]);
    assert.ok(bytes(reopenedPreKeys["2"]?.private).equals(preKey2.private));

    // A different key cannot open the stored creds, and says so instead of starting over.
    const otherKey = await generateAuthKey();
    await assert.rejects(useEncryptedSqliteAuthState(store, otherKey), (err: unknown) => {
      assert.ok(err instanceof WhatsAppAuthStateError);
      assert.match(err.message, /could not be decrypted/);
      assert.match(err.message, new RegExp(WHATSAPP_AUTH_KEYCHAIN_ITEM));
      return true;
    });
    store.close();
  });

  test("a record is bound to its row key and a short key is rejected", async () => {
    const key = await generateAuthKey();
    const blob = encryptRecord(key, "session-a", "secret");
    assert.equal(decryptRecord(key, "session-a", blob), "secret");
    assert.throws(() => decryptRecord(key, "session-b", blob), WhatsAppAuthStateError);
    assert.throws(() => encryptRecord(new Uint8Array(16), "x", "y"), /32 bytes/);
    assert.throws(() => decryptRecord(key, "x", new Uint8Array(3)), /too short/);
  });

  test("a fresh store starts from initAuthCreds-shaped credentials", async () => {
    const store = new HubStore(":memory:");
    const { state } = await useEncryptedSqliteAuthState(store, await generateAuthKey());
    const fresh = initAuthCreds();
    assert.deepEqual(Object.keys(state.creds).sort(), Object.keys(fresh).sort());
    assert.equal(store.whatsappAuthGet("creds"), null, "nothing is written until saveCreds");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const TS = 1_760_000_000; // seconds
const TS_ISO = new Date(TS * 1000).toISOString();
const NOW = new Date(TS * 1000 + 60_000);

const incoming = (message: WaMessage["message"], extra: Partial<WaMessage> = {}): WaMessage => ({
  key: { remoteJid: "15551234567@s.whatsapp.net", fromMe: false, id: "ABC123" },
  message,
  messageTimestamp: TS,
  pushName: "Alex Example",
  ...extra,
});

describe("toInboxEvent", () => {
  test("plain text from a one-to-one chat", () => {
    const ev = toInboxEvent(incoming({ conversation: "hello there" }), {}, NOW);
    assert.ok(ev);
    assert.equal(ev.service, "whatsapp");
    assert.equal(ev.v, 1);
    assert.equal(ev.conversationId, "15551234567@s.whatsapp.net");
    assert.equal(ev.conversationName, "Alex Example", "the other party's push name names the chat when no contact is known");
    assert.equal(ev.isGroup, false);
    assert.equal(ev.messageId, "ABC123");
    assert.equal(ev.senderName, "Alex Example");
    assert.equal(ev.senderIsMe, false);
    assert.equal(ev.body, "hello there");
    assert.equal(ev.sentAt, TS_ISO);
    assert.deepEqual(ev.link, { whatsapp: { jid: "15551234567@s.whatsapp.net", phone: "15551234567" } });
  });

  test("a known contact name wins over the push name, and the digits are the last resort", () => {
    const named = toInboxEvent(incoming({ conversation: "x" }), { resolveName: (jid) => (jid.startsWith("1555") ? "Alex (saved)" : undefined) }, NOW);
    assert.equal(named?.conversationName, "Alex (saved)");
    assert.equal(named?.senderName, "Alex (saved)");
    const anonymous = toInboxEvent(incoming({ conversation: "x" }, { pushName: null }), {}, NOW);
    assert.equal(anonymous?.conversationName, "15551234567");
    assert.equal(anonymous?.senderName, "15551234567");
    const explicit = toInboxEvent(incoming({ conversation: "x" }), { conversationName: "From chats.upsert" }, NOW);
    assert.equal(explicit?.conversationName, "From chats.upsert");
  });

  test("extended text", () => {
    const ev = toInboxEvent(incoming({ extendedTextMessage: { text: "see https://example.com" } }), {}, NOW);
    assert.equal(ev?.body, "see https://example.com");
  });

  test("image with and without caption", () => {
    assert.equal(toInboxEvent(incoming({ imageMessage: { caption: "the view" } }), {}, NOW)?.body, "[photo] the view");
    assert.equal(toInboxEvent(incoming({ imageMessage: { caption: null } }), {}, NOW)?.body, "[photo]");
    assert.equal(toInboxEvent(incoming({ videoMessage: { caption: "clip" } }), {}, NOW)?.body, "[video] clip");
  });

  test("voice, document, sticker, location, contact", () => {
    assert.equal(toInboxEvent(incoming({ audioMessage: { seconds: 4 } }), {}, NOW)?.body, "[voice message]");
    assert.equal(toInboxEvent(incoming({ documentMessage: { fileName: "invoice.pdf" } }), {}, NOW)?.body, "[document] invoice.pdf");
    assert.equal(toInboxEvent(incoming({ documentMessage: {} }), {}, NOW)?.body, "[document]");
    assert.equal(toInboxEvent(incoming({ stickerMessage: {} }), {}, NOW)?.body, "[sticker]");
    assert.equal(toInboxEvent(incoming({ locationMessage: {} }), {}, NOW)?.body, "[location]");
    assert.equal(toInboxEvent(incoming({ contactMessage: { displayName: "Sam" } }), {}, NOW)?.body, "[contact] Sam");
  });

  test("reactions, protocol messages and group system events produce no event", () => {
    assert.equal(toInboxEvent(incoming({ reactionMessage: { text: "👍" } }), {}, NOW), null);
    assert.equal(toInboxEvent(incoming({ protocolMessage: { type: 0 } }), {}, NOW), null);
    assert.equal(toInboxEvent(incoming({ senderKeyDistributionMessage: {}, messageContextInfo: {} }), {}, NOW), null);
    assert.equal(toInboxEvent(incoming(null), {}, NOW), null, "a stub (participant added, etc.) has no content");
    assert.equal(extractBody({ someFutureMessage: {} } as never), "[message]", "unknown content still shows up as a message");
  });

  test("ephemeral and view-once wrappers unwrap to their content", () => {
    assert.equal(toInboxEvent(incoming({ ephemeralMessage: { message: { conversation: "disappearing" } } }), {}, NOW)?.body, "disappearing");
    assert.equal(toInboxEvent(incoming({ viewOnceMessageV2: { message: { imageMessage: { caption: "once" } } } }), {}, NOW)?.body, "[photo] once");
    assert.equal(
      toInboxEvent(incoming({ ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: "nested" } } } } }), {}, NOW)?.body,
      "nested",
    );
    assert.equal(toInboxEvent(incoming({ documentWithCaptionMessage: { message: { documentMessage: { fileName: "a.txt" } } } }), {}, NOW)?.body, "[document] a.txt");
    assert.equal(toInboxEvent(incoming({ editedMessage: { message: { protocolMessage: { editedMessage: { conversation: "fixed typo" } } } } }), {}, NOW)?.body, "fixed typo");
  });

  test("group message with a participant", () => {
    const ev = toInboxEvent(
      {
        key: { remoteJid: "120363001122334455@g.us", fromMe: false, id: "G1", participant: "15559876543@s.whatsapp.net" },
        message: { conversation: "Saturday works" },
        messageTimestamp: TS,
        pushName: "Jess",
      },
      { conversationName: "Weekend Crew" },
      NOW,
    );
    assert.ok(ev);
    assert.equal(ev.isGroup, true);
    assert.equal(ev.conversationName, "Weekend Crew");
    assert.equal(ev.senderName, "Jess");
    assert.deepEqual(ev.link, { whatsapp: { jid: "120363001122334455@g.us" } }, "a group jid carries no phone");
    const unnamed = toInboxEvent({ key: { remoteJid: "120363001122334455@g.us", id: "G2" }, message: { conversation: "x" }, messageTimestamp: TS }, {}, NOW);
    assert.equal(unnamed?.conversationName, "120363001122334455", "the group id stands in until the subject is known");
    assert.equal(unnamed?.senderName, "120363001122334455", "no participant and no push name leaves the chat's digits");
  });

  test("fromMe messages are from Me and never take my push name as the chat name", () => {
    const ev = toInboxEvent(incoming({ conversation: "on my way" }, { key: { remoteJid: "15551234567@s.whatsapp.net", fromMe: true, id: "M1" }, pushName: "Brian" }), {}, NOW);
    assert.ok(ev);
    assert.equal(ev.senderIsMe, true);
    assert.equal(ev.senderName, "Me");
    assert.equal(ev.conversationName, "15551234567");
  });

  test("status and newsletter jids, and keyless messages, are ignored", () => {
    assert.equal(toInboxEvent(incoming({ conversation: "x" }, { key: { remoteJid: "status@broadcast", id: "S" } }), {}, NOW), null);
    assert.equal(toInboxEvent(incoming({ conversation: "x" }, { key: { remoteJid: "123@newsletter", id: "N" } }), {}, NOW), null);
    assert.equal(toInboxEvent(incoming({ conversation: "x" }, { key: { remoteJid: "15551234567@s.whatsapp.net", id: null } }), {}, NOW), null);
    assert.equal(shouldIgnoreJid("status@broadcast"), true);
    assert.equal(shouldIgnoreJid("15551234567@s.whatsapp.net"), false);
  });

  test("Long-like timestamps", () => {
    assert.equal(timestampToSeconds({ low: TS, high: 0, unsigned: true }), TS);
    assert.equal(timestampToIso({ low: TS, high: 0, unsigned: true }, NOW), TS_ISO);
    assert.equal(timestampToSeconds({ low: 5, high: 1, unsigned: true }), 4294967301, "the high word is weighted by 2^32");
    assert.equal(timestampToSeconds({ low: 1, high: 0, toNumber: () => 99 }), 99, "a real Long's toNumber is preferred");
    assert.equal(timestampToIso(null, NOW), NOW.toISOString(), "a missing timestamp falls back to now");
    assert.equal(timestampToIso(0, NOW), NOW.toISOString());

    // A message built by Baileys' own protobuf layer carries whatever Long shape protobufjs uses on this runtime.
    const proto = WAProto.proto.WebMessageInfo.fromObject({
      key: { remoteJid: "15551234567@s.whatsapp.net", fromMe: false, id: "P1" },
      messageTimestamp: TS,
      message: { conversation: "from protobuf" },
    });
    const ev = toInboxEvent(proto, {}, NOW);
    assert.equal(ev?.sentAt, TS_ISO);
    assert.equal(ev?.body, "from protobuf");
  });

  test("jid helpers", () => {
    assert.equal(jidPhone("15551234567@s.whatsapp.net"), "15551234567");
    assert.equal(jidPhone("15551234567:12@s.whatsapp.net"), "15551234567", "a device suffix is dropped");
    assert.equal(jidPhone("120363001122334455@g.us"), undefined);
    assert.equal(jidPhone("98765432109876@lid"), undefined, "a LID is not a phone number");
    assert.equal(jidDigits("98765432109876@lid"), "98765432109876");
    assert.equal(isGroupJid("120363001122334455@g.us"), true);
    assert.equal(isGroupJid("15551234567@s.whatsapp.net"), false);
  });

  test("the 14-day history window", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    assert.equal(withinHistoryWindow("2026-10-10T12:00:00Z", now), true);
    assert.equal(withinHistoryWindow("2026-10-02T12:00:00Z", now), true, "exactly 14 days is still in");
    assert.equal(withinHistoryWindow("2026-10-02T11:59:59Z", now), false);
    assert.equal(withinHistoryWindow("not a date", now), false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

const boom = (statusCode: number): Error => Object.assign(new Error(`closed ${statusCode}`), { output: { statusCode } });
const now = new Date("2026-10-16T12:00:00Z");
const connected: WhatsAppStatus = { state: "connected", detail: "Linked", phone: "15551234567" };
const notLinked: WhatsAppStatus = { state: "not-linked", detail: "" };
const linking: WhatsAppStatus = { state: "linking", detail: LINKING_DETAIL };

describe("nextOnConnectionUpdate", () => {
  test("qr → linking, no action", () => {
    const r = nextOnConnectionUpdate(notLinked, { qr: "2@abc,def" }, { attempt: 0, now });
    assert.equal(r.status.state, "linking");
    assert.equal(r.status.detail, LINKING_DETAIL);
    assert.deepEqual(r.action, { kind: "none" });
    assert.equal(r.linked, false);
  });

  test("open → connected with the phone; completes a link in progress", () => {
    const r = nextOnConnectionUpdate(linking, { connection: "open" }, { phone: "15551234567", attempt: 3, now });
    assert.equal(r.status.state, "connected");
    assert.equal(r.status.phone, "15551234567");
    assert.match(r.status.detail, /\+15551234567/);
    assert.deepEqual(r.action, { kind: "none" });
    assert.equal(r.linked, true);
    const resumed = nextOnConnectionUpdate({ state: "error", detail: "" }, { connection: "open" }, { phone: "15551234567", attempt: 0, now });
    assert.equal(resumed.linked, false, "a reconnect is not a link");
  });

  test("close with loggedOut → expired and clear-auth", () => {
    const r = nextOnConnectionUpdate(connected, { connection: "close", lastDisconnect: { error: boom(401), date: now } }, { attempt: 0, now });
    assert.equal(r.status.state, "expired");
    assert.equal(r.status.detail, EXPIRED_DETAIL);
    assert.match(r.status.detail, /ended on WhatsApp's side/);
    assert.deepEqual(r.action, { kind: "clear-auth" });
  });

  test("close for any other reason → error with since-when and a reconnect with backoff", () => {
    const first = nextOnConnectionUpdate(connected, { connection: "close", lastDisconnect: { error: boom(428), date: now } }, { attempt: 0, now });
    assert.equal(first.status.state, "error");
    assert.match(first.status.detail, /lost at 2026-10-16T12:00:00.000Z/);
    assert.match(first.status.detail, /code 428/);
    assert.match(first.status.detail, /reconnecting in 1s/);
    assert.deepEqual(first.action, { kind: "reconnect", delayMs: 1_000 });

    const downSince = new Date("2026-10-16T11:50:00Z");
    const later = nextOnConnectionUpdate(first.status, { connection: "close", lastDisconnect: { error: boom(408), date: now } }, { attempt: 4, downSince, now });
    assert.match(later.status.detail, /lost at 2026-10-16T11:50:00.000Z/, "the outage keeps its original start");
    assert.deepEqual(later.action, { kind: "reconnect", delayMs: 16_000 });

    const capped = nextOnConnectionUpdate(first.status, { connection: "close", lastDisconnect: { error: boom(408), date: now } }, { attempt: 12, downSince, now });
    assert.deepEqual(capped.action, { kind: "reconnect", delayMs: 60_000 });

    const noCode = nextOnConnectionUpdate(connected, { connection: "close", lastDisconnect: { error: new Error("socket hang up"), date: now } }, { attempt: 0, now });
    assert.equal(noCode.status.state, "error");
    assert.deepEqual(noCode.action, { kind: "reconnect", delayMs: 1_000 });
  });

  test("restartRequired after a scan reconnects at once and keeps the link going", () => {
    const r = nextOnConnectionUpdate(linking, { connection: "close", lastDisconnect: { error: boom(515), date: now } }, { attempt: 0, now });
    assert.equal(r.status.state, "linking");
    assert.match(r.status.detail, /Finishing/);
    assert.deepEqual(r.action, { kind: "reconnect", delayMs: 0 });
    const timedOut = nextOnConnectionUpdate(linking, { connection: "close", lastDisconnect: { error: boom(408), date: now } }, { attempt: 1, now });
    assert.equal(timedOut.status.state, "linking", "unscanned QR codes time out; the attempt continues with a fresh socket");
    assert.deepEqual(timedOut.action, { kind: "reconnect", delayMs: 2_000 });
  });

  test("connecting and empty updates", () => {
    const r = nextOnConnectionUpdate(connected, { connection: "connecting" }, { attempt: 0, now });
    assert.equal(r.status, connected, "a connected session stays connected through a transient connecting report");
    const fromError = nextOnConnectionUpdate({ state: "error", detail: "" }, { connection: "connecting" }, { attempt: 0, downSince: now, now });
    assert.equal(fromError.status.state, "error");
    assert.match(fromError.status.detail, /since 2026-10-16T12:00:00.000Z/);
    const empty = nextOnConnectionUpdate(connected, { receivedPendingNotifications: true } as never, { attempt: 0, now });
    assert.equal(empty.status, connected);
    assert.deepEqual(empty.action, { kind: "none" });
  });

  test("backoff and status-code extraction", () => {
    assert.deepEqual([0, 1, 2, 5, 6, 10].map(backoffMs), [1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
    assert.equal(disconnectStatusCode({ error: boom(440), date: now }), 440);
    assert.equal(disconnectStatusCode({ error: undefined, date: now }), undefined);
    assert.equal(disconnectStatusCode(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// The connector without a session (no socket is opened)
// ---------------------------------------------------------------------------

function fakeKeychain(): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async (k) => items.get(k) ?? null,
    set: async (k, v) => {
      items.set(k, v);
    },
    delete: async (k) => {
      items.delete(k);
    },
  };
}

function fakeHost() {
  const calls = { messages: 0, renames: [] as Array<[Service, string, string]>, statusChanges: 0 };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const host: ConnectorHost = {
    onMessage: () => {
      calls.messages += 1;
    },
    onConversationRenamed: (service, id, name) => {
      calls.renames.push([service, id, name]);
    },
    onStatusChanged: () => {
      calls.statusChanges += 1;
    },
    log: quiet,
  };
  return { host, calls, log: quiet };
}

describe("createWhatsAppConnector", () => {
  test("start() with no session reports not-linked, creates the keychain key, opens no socket", async () => {
    const store = new HubStore(":memory:");
    const keychain = fakeKeychain();
    const { host, calls, log } = fakeHost();
    const connector = createWhatsAppConnector({ host, store, keychain, config: loadConfig({}), log });

    assert.equal(connector.service, "whatsapp");
    await connector.start();
    const status = connector.status();
    assert.equal(status.state, "not-linked");
    assert.match(status.detail, /Connections → WhatsApp → Show QR code/);
    assert.equal(status.phone, undefined);
    assert.equal(calls.statusChanges, 0, "the state did not change from its initial not-linked");

    const stored = keychain.items.get(WHATSAPP_AUTH_KEYCHAIN_ITEM);
    assert.ok(stored, "the auth key was generated into the keychain");
    assert.equal(Buffer.from(stored, "base64").length, 32);
    assert.equal(store.whatsappAuthGet("creds"), null, "no credentials are written for an unlinked hub");

    await assert.rejects(connector.markRead("15551234567@s.whatsapp.net"), /WhatsApp is not connected/);
    await connector.stop();

    // A second start reuses the same key rather than minting another.
    await connector.start();
    assert.equal(keychain.items.get(WHATSAPP_AUTH_KEYCHAIN_ITEM), stored);
    await connector.stop();
    store.close();
  });

  test("start() surfaces a keychain failure as an error state and rethrows", async () => {
    const store = new HubStore(":memory:");
    const keychain: Keychain = {
      get: async () => {
        throw new Error("keychain locked");
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const { host, calls, log } = fakeHost();
    const connector = createWhatsAppConnector({ host, store, keychain, config: loadConfig({}), log });
    await assert.rejects(connector.start(), /keychain locked/);
    assert.equal(connector.status().state, "error");
    assert.match(connector.status().detail, /credentials could not be opened: keychain locked/);
    assert.equal(calls.statusChanges, 1);
    store.close();
  });
});
