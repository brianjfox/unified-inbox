import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HubStore, appendMessage, conversationKey } from "../src/store.ts";
import { Normalizer } from "../src/normalizer.ts";
import { ReadBackUnavailableError, type Connector } from "../src/connectors/types.ts";
import type { InboxEvent } from "@inbox/shared/schema";

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function event(over: Partial<InboxEvent> = {}): InboxEvent {
  return {
    v: 1,
    service: "slack",
    conversationId: "D1",
    conversationName: "Maria Chen",
    isGroup: false,
    workspaceId: "T1",
    workspaceName: "Acme",
    messageId: "1700000001.000100",
    senderName: "Maria Chen",
    senderIsMe: false,
    body: "Can you look at the deck before 3?",
    sentAt: "2026-01-01T12:31:00.000Z",
    link: { slack: { teamId: "T1", channelId: "D1", teamDomain: "acme" } },
    ...over,
  };
}

describe("store", () => {
  test("conversations round-trip and dirty tracking works", () => {
    const store = new HubStore(":memory:");
    assert.equal(store.dirtyConversations().length, 0);
    const state = { v: 1 as const, service: "slack" as const, conversationId: "D1", name: "Maria", isGroup: false, messages: [], lastMessageAt: "2026-01-01T00:00:00Z", preview: "", unread: false, unreadCount: 0, link: {} };
    store.putConversation(state);
    const dirty = store.dirtyConversations();
    assert.equal(dirty.length, 1);
    store.markUploaded(dirty[0]!.row.key, "art_1", 1);
    store.clearDirtyIfUnchanged(dirty[0]!.row.key, dirty[0]!.row.updated_at);
    assert.equal(store.dirtyConversations().length, 0);
    assert.equal(store.getConversation("slack", "D1")?.row.artifact_id, "art_1");
    // A change after upload began keeps the row dirty.
    store.putConversation({ ...state, name: "Maria Chen" });
    store.clearDirtyIfUnchanged(dirty[0]!.row.key, dirty[0]!.row.updated_at);
    assert.equal(store.dirtyConversations().length, 1);
    store.close();
  });

  test("appendMessage keeps order, dedupes and caps", () => {
    const state = { v: 1 as const, service: "slack" as const, conversationId: "D1", name: "x", isGroup: false, messages: [] as { id: string; senderName: string; senderIsMe: boolean; body: string; sentAt: string }[], lastMessageAt: "", preview: "", unread: false, unreadCount: 0, link: {} };
    assert.equal(appendMessage(state, { id: "b", senderName: "x", senderIsMe: false, body: "", sentAt: "2026-01-02T00:00:00Z" }), true);
    assert.equal(appendMessage(state, { id: "a", senderName: "x", senderIsMe: false, body: "", sentAt: "2026-01-01T00:00:00Z" }), true);
    assert.equal(appendMessage(state, { id: "a", senderName: "x", senderIsMe: false, body: "", sentAt: "2026-01-01T00:00:00Z" }), false);
    assert.deepEqual(state.messages.map((m) => m.id), ["a", "b"]);
    assert.equal(state.lastMessageAt, "2026-01-02T00:00:00Z");
    for (let i = 0; i < 250; i++) appendMessage(state, { id: `m${i}`, senderName: "x", senderIsMe: false, body: "", sentAt: `2026-02-01T00:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}Z` });
    assert.equal(state.messages.length, 200);
  });

  test("oauth states are single use", () => {
    const store = new HubStore(":memory:");
    store.putOauthState("s1", "dev_a", "https://r/cb");
    assert.deepEqual(store.takeOauthState("s1")?.viewer_device_id, "dev_a");
    assert.equal(store.takeOauthState("s1"), null);
    store.close();
  });
});

describe("normalizer", () => {
  function setup() {
    const store = new HubStore(":memory:");
    const marked: string[] = [];
    const slack: Connector = { service: "slack", start: async () => {}, stop: async () => {}, markRead: async (id) => void marked.push(id) };
    const imessage: Connector = {
      service: "imessage",
      start: async () => {},
      stop: async () => {},
      markRead: async () => {
        throw new ReadBackUnavailableError("fallback");
      },
    };
    let changes = 0;
    const n = new Normalizer(store, new Map([["slack", slack], ["imessage", imessage]]), silent, () => changes++);
    return { store, n, marked, changes: () => changes };
  }

  test("ingest creates the conversation, counts unread, builds the preview, dedupes", () => {
    const { store, n, changes } = setup();
    n.ingest(event());
    n.ingest(event()); // duplicate
    const conv = store.getConversation("slack", "D1")!;
    assert.equal(conv.state.unread, true);
    assert.equal(conv.state.unreadCount, 1);
    assert.equal(conv.state.preview, "Can you look at the deck before 3?");
    assert.equal(conv.state.messages.length, 1);
    assert.equal(conv.state.workspaceName, "Acme");
    assert.equal(changes(), 1);
    n.ingest(event({ messageId: "1700000002.000100", sentAt: "2026-01-01T12:32:00.000Z", body: "second" }));
    assert.equal(store.getConversation("slack", "D1")!.state.unreadCount, 2);
  });

  test("my own reply clears unread; groups name the sender in the preview", () => {
    const { store, n } = setup();
    n.ingest(event({ conversationId: "G1", conversationName: "Weekend Crew", isGroup: true, senderName: "Sam", body: "who's driving Saturday?" }));
    assert.equal(store.getConversation("slack", "G1")!.state.preview, "Sam: who's driving Saturday?");
    n.ingest(event({ conversationId: "G1", conversationName: "Weekend Crew", isGroup: true, messageId: "me1", senderIsMe: true, senderName: "Me", body: "I can", sentAt: "2026-01-01T12:40:00.000Z" }));
    const st = store.getConversation("slack", "G1")!.state;
    assert.equal(st.unread, false);
    assert.equal(st.unreadCount, 0);
    assert.equal(st.preview, "I can");
  });

  test("markRead writes back to exactly one connector; read-back unavailable is tolerated", async () => {
    const { store, n, marked } = setup();
    n.ingest(event());
    n.ingest(event({ service: "imessage", conversationId: "iMessage;-;+1555", conversationName: "Dad", messageId: "g1", link: { imessage: { handles: ["+1555"], chatGuid: "iMessage;-;+1555" } } }));
    await n.markRead([conversationKey("slack", "D1"), conversationKey("imessage", "iMessage;-;+1555")]);
    assert.deepEqual(marked, ["D1"]);
    assert.equal(store.getConversation("slack", "D1")!.state.unread, false);
    assert.equal(store.getConversation("imessage", "iMessage;-;+1555")!.state.unread, false);
    // Marking read again does not write back again (it was not unread).
    await n.markRead([conversationKey("slack", "D1")]);
    assert.deepEqual(marked, ["D1"]);
    await n.markUnread([conversationKey("slack", "D1")]);
    assert.equal(store.getConversation("slack", "D1")!.state.unread, true);
    // A message older than readAt does not flip it back to unread.
    n.ingest(event({ conversationId: "D1", messageId: "old", sentAt: "2025-12-31T00:00:00.000Z" }));
    await n.markAllRead();
    assert.equal(store.allConversations().every((c) => !c.state.unread), true);
  });

  test("rename updates the name only", () => {
    const { store, n } = setup();
    n.ingest(event());
    n.rename("slack", "D1", "Maria C.");
    assert.equal(store.getConversation("slack", "D1")!.state.name, "Maria C.");
    n.rename("slack", "nope", "x");
  });
});

describe("sync client flush", () => {
  test("concurrent flushes never create an artifact twice", async () => {
    const { SyncClient } = await import("../src/sync.ts");
    const store = new HubStore(":memory:");
    let created = 0;
    let revised = 0;
    const relay = {
      async createConversation(title: string) {
        created++;
        await new Promise((r) => setTimeout(r, 5));
        return { artifact: { id: `art_${title}`, version: 1 } };
      },
      async reviseArtifact(id: string) {
        revised++;
        return { artifactId: id, version: 2 };
      },
    };
    const identity = { relay, inboxKey: "k".repeat(43), keys: { publicKey: "", secretKey: "" }, deviceId: "dev_x", device: {} } as never;
    // sealBlob needs a real key; use a generated one.
    const crypto = await import("@inbox/shared/crypto");
    await crypto.ready();
    (identity as { inboxKey: string }).inboxKey = await crypto.generateInboxKey();
    const sync = new SyncClient(identity, store, silent, { mailDomain: "x" });
    for (let i = 0; i < 20; i++) {
      store.putConversation({ v: 1, service: "slack", conversationId: `C${i}`, name: `c${i}`, isGroup: false, messages: [], lastMessageAt: "2026-01-01T00:00:00Z", preview: "", unread: false, unreadCount: 0, link: {} });
    }
    await Promise.all(Array.from({ length: 50 }, () => sync.flush()));
    assert.equal(created, 20);
    assert.equal(store.dirtyConversations().length, 0);
    // A change during a flush is picked up by the follow-up pass, as a revision.
    const p = sync.flush();
    store.putConversation({ v: 1, service: "slack", conversationId: "C0", name: "renamed", isGroup: false, messages: [], lastMessageAt: "2026-01-01T00:00:00Z", preview: "", unread: false, unreadCount: 0, link: {} });
    await sync.flush();
    await p;
    assert.equal(created, 20);
    assert.equal(revised, 1);
    assert.equal(store.dirtyConversations().length, 0);
    sync.stop();
    store.close();
  });
});
