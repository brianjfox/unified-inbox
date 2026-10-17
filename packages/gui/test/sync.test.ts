import { describe, expect, test } from "bun:test";
import * as crypto from "@inbox/shared/crypto";
import { RelayClient, type FetchLike } from "@inbox/shared/relay-client";
import type { ConversationState } from "@inbox/shared/schema";
import { planSync, pullChanges, conversationKey } from "../src/lib/sync.ts";

function conv(service: ConversationState["service"], id: string, name: string, unread: boolean): ConversationState {
  return {
    v: 1,
    service,
    conversationId: id,
    name,
    isGroup: false,
    messages: [{ id: "m1", senderName: name, senderIsMe: false, body: `hello from ${name}`, sentAt: "2026-10-16T12:00:00.000Z" }],
    lastMessageAt: "2026-10-16T12:00:00.000Z",
    preview: `hello from ${name}`,
    unread,
    unreadCount: unread ? 1 : 0,
    link: {},
  };
}

describe("planSync", () => {
  test("fetches every listed artifact when nothing is cached", () => {
    const plan = planSync(
      [
        { id: "a", version: 3, archivedAt: null },
        { id: "b", version: 1, archivedAt: null },
      ],
      () => undefined,
    );
    expect(plan).toEqual({ fetch: ["a", "b"], reachedKnown: false });
  });

  test("stops at the first artifact already cached at its listed version", () => {
    const known = new Map([
      ["b", 1],
      ["c", 7],
    ]);
    const plan = planSync(
      [
        { id: "a", version: 3, archivedAt: null },
        { id: "b", version: 1, archivedAt: null },
        { id: "c", version: 8, archivedAt: null },
      ],
      (id) => known.get(id),
    );
    expect(plan).toEqual({ fetch: ["a"], reachedKnown: true });
  });

  test("fetches a cached artifact whose version moved on", () => {
    const known = new Map([["a", 2]]);
    const plan = planSync([{ id: "a", version: 3, archivedAt: null }], (id) => known.get(id));
    expect(plan).toEqual({ fetch: ["a"], reachedKnown: false });
  });

  test("skips archived artifacts", () => {
    const plan = planSync(
      [
        { id: "a", version: 1, archivedAt: "2026-01-01T00:00:00Z" },
        { id: "b", version: 1, archivedAt: null },
      ],
      () => undefined,
    );
    expect(plan.fetch).toEqual(["b"]);
  });
});

describe("pullChanges against a relay faked at the network edge", () => {
  test("pages until it reaches a known artifact and opens, validates and returns the rest", async () => {
    await crypto.ready();
    const keys = await crypto.generateDeviceKeys();
    const inboxKey = await crypto.generateInboxKey();
    const items = [
      { id: "art-3", version: 2, state: conv("slack", "C3", "Maria Chen", true) },
      { id: "art-2", version: 1, state: conv("imessage", "chat2", "Dad", true) },
      { id: "art-1", version: 5, state: conv("whatsapp", "123@s.whatsapp.net", "Priya Nair", false) },
      { id: "art-0", version: 1, state: conv("slack", "C0", "Hannah", false) },
    ];
    const requested: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      requested.push(`${init.method} ${u.pathname}${u.search}`);
      expect(init.headers.Authorization).toMatch(/^Device dev_/);
      const list = /\/artifacts$/.exec(u.pathname);
      if (list) {
        const cursor = u.searchParams.get("cursor");
        const page = cursor === "p2" ? items.slice(2) : items.slice(0, 2);
        const nextCursor = cursor === "p2" ? null : "p2";
        const artifacts = page.map((i) => ({ id: i.id, kind: "inbox.conversation", title: "t", version: i.version, updatedAt: "2026-10-16T12:00:00Z", createdAt: "2026-10-16T12:00:00Z", archivedAt: null, metadata: null }));
        return new Response(JSON.stringify({ artifacts, nextCursor }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const detail = /\/artifacts\/([^/]+)$/.exec(u.pathname);
      if (detail) {
        const item = items.find((i) => i.id === decodeURIComponent(detail[1]!));
        if (!item) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        const content = item.id === "art-1" ? "ib1.garbage.garbage" : crypto.sealBlob(inboxKey, item.state);
        return new Response(JSON.stringify({ artifact: { id: item.id, kind: "inbox.conversation", title: "t", version: item.version, updatedAt: "", createdAt: "", archivedAt: null, metadata: null, content } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    };
    const relay = new RelayClient({ baseUrl: "https://relay.test", tenantId: "inbox", keys, fetch });
    const known = new Map([["art-0", 1]]);
    const result = await pullChanges(relay, inboxKey, (id) => known.get(id), 2);

    expect(result.changed.map((c) => c.artifactId)).toEqual(["art-3", "art-2"]);
    expect(result.changed[0]!.state.name).toBe("Maria Chen");
    expect(conversationKey(result.changed[0]!.state)).toBe("slack:C3");
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("art-1");
    expect(requested.filter((r) => r.includes("/artifacts?"))).toHaveLength(2);
    expect(requested).not.toContain("GET /api/tenants/inbox/artifacts/art-0");
  });

  test("a second pass with everything cached fetches nothing", async () => {
    await crypto.ready();
    const keys = await crypto.generateDeviceKeys();
    const inboxKey = await crypto.generateInboxKey();
    let detailCalls = 0;
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      if (/\/artifacts$/.test(u.pathname)) {
        return new Response(JSON.stringify({ artifacts: [{ id: "a", kind: "inbox.conversation", title: "t", version: 4, updatedAt: "", createdAt: "", archivedAt: null, metadata: null }], nextCursor: null }), { status: 200 });
      }
      detailCalls++;
      return new Response("{}", { status: 200 });
    };
    const relay = new RelayClient({ baseUrl: "https://relay.test", keys, fetch });
    const result = await pullChanges(relay, inboxKey, () => 4);
    expect(result.changed).toEqual([]);
    expect(detailCalls).toBe(0);
  });
});
