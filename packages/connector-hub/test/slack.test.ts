import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { InboxEvent } from "@inbox/shared/schema";
import { HubStore } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import type { Keychain } from "../src/keychain.ts";
import type { ConnectorHost } from "../src/connectors/types.ts";
import { createSlackConnector, type SlackConnectorHandle } from "../src/connectors/slack.ts";
import type { SocketModeEnvelope } from "../src/connectors/slack/events.ts";

/**
 * The connector's real code runs against a local server that speaks Slack's
 * wire format: the Web API over HTTP (form-encoded POSTs, JSON replies, a
 * Bearer token) and Socket Mode over a WebSocket that says hello and
 * collects acknowledgements. Nothing here reaches slack.com.
 */

const silent = { info() {}, warn() {}, error() {}, debug() {} };

type Call = { method: string; params: URLSearchParams; token: string | null };
type Handler = (call: Call) => Record<string, unknown>;

class FakeSlack {
  readonly calls: Call[] = [];
  readonly acks: Array<{ envelope_id: string; payload: unknown }> = [];
  readonly sockets: WebSocket[] = [];
  private readonly handlers = new Map<string, Handler>();
  private server!: Server;
  private wss!: WebSocketServer;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => {
        this.acks.push(JSON.parse(data.toString()) as { envelope_id: string; payload: unknown });
      });
      socket.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/`;
    this.reset();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Delivers an Events API envelope over the open Socket Mode connection. */
  push(envelopeId: string, payload: Record<string, unknown>): void {
    const socket = this.sockets.at(-1);
    assert.ok(socket, "a Socket Mode connection is open");
    socket.send(JSON.stringify({ envelope_id: envelopeId, type: "events_api", accepts_response_payload: false, payload }));
  }

  /** Default behavior of every endpoint the connector calls; tests override per case. */
  reset(): void {
    this.calls.length = 0;
    this.acks.length = 0;
    this.handlers.clear();
    const { port } = this.server.address() as AddressInfo;
    this.on("apps.connections.open", () => ({ ok: true, url: `ws://127.0.0.1:${port}/link/abc` }));
    this.on("oauth.v2.access", (c) => {
      if (c.params.get("client_id") !== "cid" || c.params.get("client_secret") !== "sec") return { ok: false, error: "invalid_client_id" };
      if (c.params.get("code") !== "good-code") return { ok: false, error: "invalid_code" };
      return {
        ok: true,
        app_id: "A1",
        authed_user: { id: "U1", scope: "im:history,im:read,im:write,mpim:history,mpim:read,mpim:write,users:read", access_token: "xoxp-user-1", token_type: "user" },
        team: { id: "T1", name: "Acme" },
        enterprise: null,
        is_enterprise_install: false,
      };
    });
    this.on("auth.test", (c) => (c.token === "xoxp-user-1" ? { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "brian", team_id: "T1", user_id: "U1" } : { ok: false, error: "invalid_auth" }));
    this.on("users.conversations", () => ({
      ok: true,
      channels: [
        { id: "D1", is_im: true, user: "U2", created: 1 },
        { id: "G1", is_mpim: true, name: "mpdm-brian--maria--dev-1", created: 2 },
      ],
      response_metadata: { next_cursor: "" },
    }));
    this.on("conversations.history", (c) => {
      const oldest = Number(c.params.get("oldest") ?? "0");
      const all = HISTORY[c.params.get("channel") ?? ""] ?? [];
      const messages = all.filter((m) => Number(m.ts) > oldest).sort((a, b) => Number(b.ts) - Number(a.ts));
      return { ok: true, messages, has_more: false, response_metadata: { next_cursor: "" } };
    });
    this.on("users.info", (c) => {
      const user = USERS[c.params.get("user") ?? ""];
      return user ? { ok: true, user } : { ok: false, error: "user_not_found" };
    });
    this.on("conversations.members", () => ({ ok: true, members: ["U1", "U2", "U3"], response_metadata: { next_cursor: "" } }));
    this.on("conversations.info", () => ({ ok: true, channel: { id: "D1", is_im: true, user: "U2" } }));
    this.on("conversations.mark", () => ({ ok: true }));
    this.on("auth.revoke", () => ({ ok: true, revoked: true }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const contentType = req.headers["content-type"] ?? "";
    const params = contentType.includes("json") ? new URLSearchParams(Object.entries(JSON.parse(raw || "{}") as Record<string, string>)) : new URLSearchParams(raw);
    const method = new URL(req.url ?? "/", this.url).pathname.replace(/^\//, "");
    const auth = req.headers.authorization;
    const call: Call = { method, params, token: auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null };
    this.calls.push(call);
    const handler = this.handlers.get(method);
    const body = handler ? handler(call) : { ok: false, error: "unknown_method" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

/** History is anchored an hour ago so it falls inside the 14-day seed window. */
const BASE = Math.floor(Date.now() / 1000) - 3600;
const ts = (n: number) => `${BASE + n}.000100`;
const HISTORY: Record<string, Array<Record<string, unknown> & { ts: string }>> = {
  D1: [
    { type: "message", user: "U2", text: "Can you look at the deck before 3?", ts: ts(1), team: "T1" },
    { type: "message", user: "U1", text: "On it, <@U2> &amp; thanks", ts: ts(2), team: "T1" },
    { type: "message", subtype: "message_changed", hidden: true, ts: ts(3), message: { type: "message", user: "U2", text: "edited", ts: ts(1) } },
    { type: "message", subtype: "bot_message", bot_id: "B1", text: "reminder", ts: ts(4) },
  ],
  G1: [{ type: "message", user: "U3", text: "lunch?", ts: ts(5), team: "T1" }],
};
const USERS: Record<string, Record<string, unknown>> = {
  U1: { id: "U1", name: "brian", real_name: "Brian Fox", profile: { display_name: "", real_name: "Brian Fox" } },
  U2: { id: "U2", name: "maria", real_name: "Maria Chen", profile: { display_name: "", real_name: "Maria Chen" } },
  U3: { id: "U3", name: "dev", real_name: "Dev Patel", profile: { display_name: "devp", real_name: "Dev Patel" } },
};

function memoryKeychain(): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    async get(key) {
      return items.get(key) ?? null;
    },
    async set(key, value) {
      items.set(key, value);
    },
    async delete(key) {
      items.delete(key);
    },
  };
}

function makeHost(): { host: ConnectorHost; events: InboxEvent[]; statusChanges: () => number } {
  const events: InboxEvent[] = [];
  let changes = 0;
  const host: ConnectorHost = {
    onMessage: (e) => void events.push(e),
    onConversationRenamed: () => undefined,
    onStatusChanged: () => void (changes += 1),
    log: silent,
  };
  return { host, events, statusChanges: () => changes };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const APP = { clientId: "cid", clientSecret: "sec", appToken: "xapp-1-A1-test" };
const REDIRECT = "https://inbox.example.com/oauth/slack/callback";

function envelope(type: string, body: unknown): SocketModeEnvelope & { acked: number } {
  const env = {
    acked: 0,
    type,
    body,
    envelope_id: "env-direct",
    ack: async () => {
      env.acked += 1;
    },
  };
  return env;
}

describe("slack connector", () => {
  const slack = new FakeSlack();
  let store: HubStore;
  let keychain: ReturnType<typeof memoryKeychain>;
  let hostBits: ReturnType<typeof makeHost>;
  let connector: SlackConnectorHandle;
  const config = loadConfig({});

  before(() => slack.start());
  after(() => slack.stop());
  beforeEach(() => {
    slack.reset();
    store = new HubStore(":memory:");
    keychain = memoryKeychain();
    hostBits = makeHost();
    connector = createSlackConnector({ host: hostBits.host, store, keychain, config, log: silent, slackApiUrl: slack.url });
  });
  // A failed assertion must not leave a live Socket Mode client reconnecting against a closed server.
  afterEach(() => connector.stop());

  test("reports not-configured until the app is saved, and refuses to start a connect before then", async () => {
    await connector.start();
    const s = connector.status();
    assert.equal(s.state, "not-configured");
    assert.equal(s.appConfigured, false);
    assert.match(s.detail, /Slack app settings/);
    await assert.rejects(connector.startConnect("viewer-1", REDIRECT), /Slack app settings have not been saved/);
    await connector.stop();
  });

  test("saveApp validates the shape, keeps secrets only in the keychain, and moves status to no-workspaces", async () => {
    await connector.start();
    await assert.rejects(connector.saveApp({ ...APP, appToken: "xoxb-not-an-app-token" }), /xapp-/);
    await assert.rejects(connector.saveApp({ ...APP, clientSecret: "" }), /client secret/);
    const before = hostBits.statusChanges();
    await connector.saveApp(APP);
    assert.ok(hostBits.statusChanges() > before, "status change announced");
    const s = connector.status();
    assert.equal(s.state, "no-workspaces");
    assert.equal(s.appConfigured, true);
    assert.deepEqual(JSON.parse(keychain.items.get("slack-app") ?? "{}"), APP);
    const kv = store.db.prepare("SELECT v FROM kv").all() as Array<{ v: string }>;
    assert.ok(kv.every((row) => !row.v.includes("sec") && !row.v.includes("xapp-")), "no secret in the store");
    await connector.stop();
  });

  test("startConnect builds Slack's authorize URL with user_scope and records a viewer-bound state", async () => {
    await connector.start();
    await connector.saveApp(APP);
    const { url } = await connector.startConnect("viewer-1", REDIRECT);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://slack.com/oauth/v2/authorize");
    assert.equal(u.searchParams.get("client_id"), "cid");
    assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(u.searchParams.get("response_type"), "code");
    const userScope = u.searchParams.get("user_scope") ?? "";
    for (const scope of ["im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read"]) assert.ok(userScope.split(",").includes(scope), scope);
    const state = u.searchParams.get("state");
    assert.ok(state && state.length >= 32, "state is a long nonce");
    const stored = store.takeOauthState(state);
    assert.equal(stored?.viewer_device_id, "viewer-1");
    assert.equal(stored?.redirect_uri, REDIRECT);
    await connector.stop();
  });

  test("finishConnect rejects an unknown, foreign, expired or reused state and surfaces Slack's error", async () => {
    await connector.start();
    await connector.saveApp(APP);
    await assert.rejects(connector.finishConnect("viewer-1", "good-code", "nope", REDIRECT), /not started by this hub|already used/);

    const { url } = await connector.startConnect("viewer-1", REDIRECT);
    const state = new URL(url).searchParams.get("state")!;
    await assert.rejects(connector.finishConnect("viewer-2", "good-code", state, REDIRECT), /different device/);
    await assert.rejects(connector.finishConnect("viewer-1", "good-code", state, REDIRECT), /not started by this hub|already used/, "state is single use");

    store.putOauthState("old-state", "viewer-1", REDIRECT);
    store.db.prepare("UPDATE oauth_state SET created_at = ? WHERE state = ?").run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), "old-state");
    await assert.rejects(connector.finishConnect("viewer-1", "good-code", "old-state", REDIRECT), /expired/);

    const second = new URL((await connector.startConnect("viewer-1", REDIRECT)).url).searchParams.get("state")!;
    await assert.rejects(connector.finishConnect("viewer-1", "good-code", second, "https://elsewhere.example.com/cb"), /different redirect URL/);

    const third = new URL((await connector.startConnect("viewer-1", REDIRECT)).url).searchParams.get("state")!;
    await assert.rejects(connector.finishConnect("viewer-1", "bad-code", third, REDIRECT), /invalid_code/);
    assert.equal(store.slackWorkspaces().length, 0);
    assert.equal(keychain.items.has("slack-token-T1"), false);
    assert.equal(connector.status().state, "no-workspaces");
    await connector.stop();
  });

  test("finishConnect stores the token, records the workspace, seeds history oldest-first, receives live events, marks read and removes", async () => {
    await connector.start();
    await connector.saveApp(APP);
    const state = new URL((await connector.startConnect("viewer-1", REDIRECT)).url).searchParams.get("state")!;

    const team = await connector.finishConnect("viewer-1", "good-code", state, REDIRECT);
    assert.deepEqual(team, { teamId: "T1", teamName: "Acme" });
    assert.equal(keychain.items.get("slack-token-T1"), "xoxp-user-1");
    const exchange = slack.callsTo("oauth.v2.access")[0]!;
    assert.equal(exchange.params.get("redirect_uri"), REDIRECT);
    assert.equal(exchange.params.get("code"), "good-code");
    const ws = store.slackWorkspaces();
    assert.equal(ws.length, 1);
    assert.equal(ws[0]!.team_id, "T1");
    assert.equal(ws[0]!.name, "Acme");
    assert.equal(ws[0]!.team_domain, "acme");
    assert.equal(ws[0]!.user_id, "U1");

    // The initial fetch: one call per listed conversation, oldest about 14 days back.
    await connector.whenIdle();
    const historyCalls = slack.callsTo("conversations.history");
    assert.deepEqual(
      historyCalls.map((c) => c.params.get("channel")),
      ["D1", "G1"],
    );
    for (const c of historyCalls) {
      assert.equal(c.token, "xoxp-user-1");
      const oldest = Number(c.params.get("oldest"));
      assert.ok(Math.abs(oldest - (Date.now() / 1000 - 14 * 86400)) < 120, "oldest is now minus 14 days");
    }
    const events = hostBits.events;
    assert.equal(events.length, 3, "edits and bot messages are not emitted");
    const [first, second, group] = events as [InboxEvent, InboxEvent, InboxEvent];
    assert.equal(first.service, "slack");
    assert.equal(first.conversationId, "D1");
    assert.equal(first.messageId, ts(1));
    assert.equal(first.senderIsMe, false);
    assert.equal(first.senderName, "Maria Chen");
    assert.equal(first.conversationName, "Maria Chen");
    assert.equal(first.isGroup, false);
    assert.equal(first.workspaceId, "T1");
    assert.equal(first.workspaceName, "Acme");
    assert.equal(first.sentAt, new Date((BASE + 1) * 1000).toISOString());
    assert.deepEqual(first.link, { slack: { teamId: "T1", channelId: "D1", teamDomain: "acme" } });
    assert.equal(second.messageId, ts(2));
    assert.equal(second.senderIsMe, true);
    assert.equal(second.senderName, "Brian Fox");
    assert.equal(second.body, "On it, @Maria Chen & thanks", "cached mentions and entities are rendered");
    assert.ok(Number(first.messageId) < Number(second.messageId), "oldest first");
    assert.equal(group.conversationId, "G1");
    assert.equal(group.isGroup, true);
    assert.equal(group.conversationName, "Maria Chen, devp", "display name wins over real name");
    assert.equal(group.senderName, "devp");
    assert.equal(store.getKv("slack:latest:T1:D1"), ts(2));
    assert.equal(store.getKv("slack:channel-team:D1"), "T1");
    assert.equal(store.getKv("slack:channel-team:G1"), "T1");

    // Socket Mode: the real client fetched its URL from apps.connections.open and received hello.
    await waitFor(() => connector.status().state === "connected", "socket mode connected");
    const connected = connector.status();
    assert.equal(connected.workspaces.length, 1);
    assert.equal(connected.workspaces[0]!.connected, true);
    assert.equal(connected.workspaces[0]!.name, "Acme");
    assert.equal(slack.callsTo("apps.connections.open")[0]!.token, APP.appToken);

    // A live DM arrives over the WebSocket: acknowledged, then emitted.
    slack.push("env-1", {
      team_id: "T1",
      api_app_id: "A1",
      type: "event_callback",
      event_id: "Ev1",
      authorizations: [{ team_id: "T1", user_id: "U1" }],
      event: { type: "message", channel: "D1", channel_type: "im", user: "U2", text: "Ping <@U1>?", ts: ts(10), team: "T1" },
    });
    await waitFor(() => hostBits.events.length === 4, "live event emitted");
    await waitFor(() => slack.acks.some((a) => a.envelope_id === "env-1"), "ack sent");
    const live = hostBits.events[3]!;
    assert.equal(live.messageId, ts(10));
    assert.equal(live.body, "Ping @Brian Fox?");
    assert.equal(live.senderIsMe, false);
    assert.equal(live.conversationId, "D1");
    assert.equal(store.getKv("slack:latest:T1:D1"), ts(10));

    // The handler ignores what is not a person's direct message, after acknowledging it.
    const ignored = [
      envelope("events_api", { team_id: "T1", event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", ts: ts(11), message: { text: "x" } } }),
      envelope("events_api", { team_id: "T1", event: { type: "message", subtype: "bot_message", bot_id: "B1", channel: "D1", channel_type: "im", text: "beep", ts: ts(12) } }),
      envelope("events_api", { team_id: "T1", event: { type: "message", channel: "C1", channel_type: "channel", user: "U2", text: "public", ts: ts(13) } }),
      envelope("events_api", { team_id: "T9", event: { type: "message", channel: "D9", channel_type: "im", user: "U2", text: "elsewhere", ts: ts(14) } }),
      envelope("interactive", { type: "block_actions" }),
    ];
    for (const env of ignored) {
      await connector.handleSocketEvent(env);
      assert.equal(env.acked, 1, "acknowledged");
    }
    assert.equal(hostBits.events.length, 4, "nothing else emitted");

    // A direct envelope for an mpim is handled exactly like the live one.
    const direct = envelope("events_api", { team_id: "T1", event: { type: "message", channel: "G1", channel_type: "mpim", user: "U3", text: "ready", ts: ts(15) } });
    await connector.handleSocketEvent(direct);
    assert.equal(hostBits.events.length, 5);
    assert.equal(hostBits.events[4]!.isGroup, true);
    assert.equal(hostBits.events[4]!.conversationName, "Maria Chen, devp");

    // Read-back marks the newest message seen with the workspace's own token.
    await connector.markRead("D1");
    const mark = slack.callsTo("conversations.mark");
    assert.equal(mark.length, 1);
    assert.equal(mark[0]!.params.get("channel"), "D1");
    assert.equal(mark[0]!.params.get("ts"), ts(10));
    assert.equal(mark[0]!.token, "xoxp-user-1");
    await assert.rejects(connector.markRead("D-unknown"), /not been seen/);

    // Removing revokes, deletes the token and the row, and stops the stream.
    await connector.removeWorkspace("T1");
    assert.equal(slack.callsTo("auth.revoke")[0]!.token, "xoxp-user-1");
    assert.equal(keychain.items.has("slack-token-T1"), false);
    assert.equal(store.slackWorkspaces().length, 0);
    assert.equal(connector.status().state, "no-workspaces");
    assert.equal(connector.status().workspaces.length, 0);
    await connector.stop();
  });

  test("start() with a saved app and workspace connects, fetches only history newer than the last ts seen, and reconnects after stop", async () => {
    keychain.items.set("slack-app", JSON.stringify(APP));
    keychain.items.set("slack-token-T1", "xoxp-user-1");
    store.putSlackWorkspace({ teamId: "T1", name: "Acme", teamDomain: "acme", userId: "U1" });
    store.setKv("slack:latest:T1:D1", ts(1));

    await connector.start();
    await connector.whenIdle();
    const d1 = slack.callsTo("conversations.history").find((c) => c.params.get("channel") === "D1")!;
    assert.equal(d1.params.get("oldest"), ts(1), "resumes from the newest ts seen");
    assert.deepEqual(
      hostBits.events.filter((e) => e.conversationId === "D1").map((e) => e.messageId),
      [ts(2)],
    );
    await waitFor(() => connector.status().state === "connected", "socket mode connected");
    assert.equal(connector.status().appConfigured, true);
    await connector.stop();
    assert.notEqual(connector.status().state, "connected");
  });

  test("status reports errors: a rejected app token, a workspace whose fetch fails, and a workspace missing its token", async () => {
    slack.on("apps.connections.open", () => ({ ok: false, error: "invalid_auth" }));
    slack.on("users.conversations", () => ({ ok: false, error: "missing_scope", needed: "im:read", provided: "users:read" }));
    keychain.items.set("slack-app", JSON.stringify(APP));
    keychain.items.set("slack-token-T1", "xoxp-user-1");
    store.putSlackWorkspace({ teamId: "T1", name: "Acme", teamDomain: "acme", userId: "U1" });
    store.putSlackWorkspace({ teamId: "T2", name: "Orphan Co", teamDomain: null, userId: "U7" });

    await connector.start();
    await connector.whenIdle();
    await waitFor(() => connector.status().state === "error" && /invalid_auth/.test(connector.status().detail), "socket error in status");
    const s = connector.status();
    assert.equal(s.appConfigured, true);
    assert.equal(s.workspaces.length, 2);
    const acme = s.workspaces.find((w) => w.teamId === "T1")!;
    assert.equal(acme.connected, false);
    assert.match(acme.error ?? "", /missing_scope/);
    const orphan = s.workspaces.find((w) => w.teamId === "T2")!;
    assert.equal(orphan.connected, false);
    assert.match(orphan.error ?? "", /missing from the keychain/);
    await connector.stop();
  });
});
