import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { RelayClient, RelayError } from "@inbox/shared/relay-client";
import { CONVERSATION_ARTIFACT_KIND, conversationArtifactTitle, type HubBoundEvent } from "@inbox/shared/protocol";
import * as crypto from "@inbox/shared/crypto";
import { dbConfigFromUrl, type RelayConfig } from "../src/config.ts";
import { ensureTenant, migrate, openRelayDb, type Relay } from "../src/db.ts";
import { createRelayApp } from "../src/app.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/unified_inbox_test";
const dbConfig = dbConfigFromUrl(DATABASE_URL);
const config: RelayConfig = {
  port: 0,
  host: "127.0.0.1",
  publicOrigin: "http://relay.test",
  db: dbConfig,
  tenant: { id: "inbox", slug: "inbox", name: "Unified Inbox", domain: "relay.test" },
  guiDir: "/nonexistent",
};

let relay: Relay;
let fetchApp: (url: string, init?: RequestInit) => Promise<Response>;

async function resetDatabase() {
  const { db, close } = createDB(dbConfig);
  try {
    for (const schema of ["inbox_relay", "artifacts", "mailbox", "public", "drizzle"]) {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
    }
    await db.execute(sql.raw(`CREATE SCHEMA public`));
  } finally {
    await close();
  }
}

beforeAll(async () => {
  await crypto.ready();
  await resetDatabase();
  await migrate(dbConfig);
  relay = openRelayDb(dbConfig);
  await ensureTenant(relay, config.tenant);
  const app = createRelayApp(relay, config);
  fetchApp = (url, init) => Promise.resolve(app.fetch(new Request(url, init)));
});

afterAll(async () => {
  await relay?.close();
});

function client(keys?: crypto.DeviceKeys) {
  return new RelayClient({ baseUrl: "http://relay.test", keys, fetch: (url, init) => fetchApp(url, init as RequestInit) });
}

describe("relay", () => {
  test("health answers without a device", async () => {
    expect((await client().health()).ok).toBe(true);
  });

  test("enrollment, approval, sealed sync and sealed mail end to end", async () => {
    const hubKeys = await crypto.generateDeviceKeys();
    const viewerKeys = await crypto.generateDeviceKeys();
    const strangerKeys = await crypto.generateDeviceKeys();
    const inboxKey = await crypto.generateInboxKey();

    // The first hub is approved on enrollment; a viewer waits.
    const hub = client(hubKeys);
    const enrolledHub = await hub.enroll({ publicKey: hubKeys.publicKey, label: "Studio Mac mini", kind: "hub", platform: "macos" });
    expect(enrolledHub.device.approvedAt).not.toBeNull();
    expect(enrolledHub.device.id).toBe(crypto.deviceIdFor(hubKeys.publicKey));

    const viewer = client(viewerKeys);
    const enrolledViewer = await viewer.enroll({ publicKey: viewerKeys.publicKey, label: "Office PC", kind: "viewer", platform: "windows" });
    expect(enrolledViewer.device.approvedAt).toBeNull();
    expect((await viewer.me()).device.approvedAt).toBeNull();
    await expect(viewer.devices()).rejects.toMatchObject({ status: 403 });
    await expect(viewer.listArtifacts()).rejects.toMatchObject({ status: 403 });

    // A second hub enrolling is not auto-approved.
    const hub2Keys = await crypto.generateDeviceKeys();
    const hub2 = await client(hub2Keys).enroll({ publicKey: hub2Keys.publicKey, label: "Other Mac", kind: "hub" });
    expect(hub2.device.approvedAt).toBeNull();

    // The hub approves the viewer, wrapping the inbox key for it.
    await hub.approveDevice(enrolledViewer.device.id, crypto.wrapInboxKey(inboxKey, viewerKeys.publicKey));
    const me = (await viewer.me()).device;
    expect(me.approvedAt).not.toBeNull();
    expect(crypto.unwrapInboxKey(me.wrappedInboxKey!, viewerKeys)).toBe(inboxKey);
    // A stranger cannot unwrap it.
    expect(() => crypto.unwrapInboxKey(me.wrappedInboxKey!, strangerKeys)).toThrow();
    // The devices list never includes wrapped keys.
    const devices = (await viewer.devices()).devices;
    expect(devices.find((d) => d.id === me.id)).toBeDefined();
    expect(devices.some((d) => "wrappedInboxKey" in d)).toBe(false);

    // Only the hub creates conversations; content is sealed before upload.
    const state = { v: 1, service: "slack", conversationId: "C1", name: "Maria Chen", messages: [{ id: "1", body: "SECRET-MARKER-ALPHA" }] };
    const sealed = crypto.sealBlob(inboxKey, state);
    await expect(viewer.createConversation("x", sealed)).rejects.toMatchObject({ status: 403 });
    const created = await hub.createConversation(conversationArtifactTitle("slack", "C1"), sealed);
    expect(created.artifact.kind).toBe(CONVERSATION_ARTIFACT_KIND);
    expect(created.artifact.version).toBe(1);

    // The viewer lists and opens it.
    const listed = await viewer.listArtifacts({ kind: CONVERSATION_ARTIFACT_KIND });
    expect(listed.artifacts.map((a) => a.id)).toContain(created.artifact.id);
    const fetched = await viewer.getArtifact(created.artifact.id);
    expect(crypto.openBlob(inboxKey, fetched.artifact.content)).toEqual(state);

    // Revision with optimistic concurrency.
    const revised = await hub.reviseArtifact(created.artifact.id, crypto.sealBlob(inboxKey, { ...state, unread: false }), 1);
    expect(revised.version).toBe(2);
    await expect(hub.reviseArtifact(created.artifact.id, sealed, 1)).rejects.toMatchObject({ status: 409 });

    // Viewer → hub sealed mail.
    const event: HubBoundEvent = { id: "evt-1", at: new Date().toISOString(), type: "triage.markRead", conversationIds: [created.artifact.id] };
    const envelope = crypto.sealEnvelope(event, { from: viewerKeys, toPublicKey: hubKeys.publicKey });
    await viewer.mailboxSend(enrolledHub.device.id, config.tenant.domain, envelope);
    const inbox = await hub.mailboxList();
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.fromPrincipalId).toBe(enrolledViewer.device.id);
    const opened = crypto.openEnvelope<HubBoundEvent>(inbox[0]!.body, hubKeys, (id) => devices.find((d) => d.id === id)?.publicKey);
    expect(opened.body).toEqual(event);
    expect(opened.from).toBe(enrolledViewer.device.id);
    // A stranger's key cannot open it, and a forged sender is rejected.
    expect(() => crypto.openEnvelope(inbox[0]!.body, strangerKeys, () => viewerKeys.publicKey)).toThrow();
    expect(() => crypto.openEnvelope(inbox[0]!.body, hubKeys, () => strangerKeys.publicKey)).toThrow();
    await hub.mailboxTrash(inbox[0]!.uid);
    expect((await hub.mailboxList()).length).toBe(0);
    // Housekeeping: the hub's Trash and the viewer's Sent copies can be purged.
    expect((await hub.mailboxPurge()).purged).toBeGreaterThan(0);
    expect((await viewer.mailboxPurge()).purged).toBeGreaterThan(0);
    // A device with unprocessed mail is refused.
    await viewer.mailboxSend(enrolledHub.device.id, config.tenant.domain, envelope);
    expect((await hub.mailboxPurge()).skipped).toBeDefined();
    await hub.mailboxTrash((await hub.mailboxList())[0]!.uid);

    // Heartbeat and status.
    await hub.heartbeat(crypto.sealBlob(inboxKey, { v: 1, at: new Date().toISOString() }));
    const status = await viewer.hubStatus();
    expect(status.hub?.deviceId).toBe(enrolledHub.device.id);
    expect(status.hub?.lastHeartbeatAt).not.toBeNull();
    await expect(viewer.heartbeat("x")).rejects.toMatchObject({ status: 403 });

    // AC-18: relay-side inspection finds no plaintext anywhere.
    const dump = await relay.db.execute(sql.raw(`
      SELECT string_agg(coalesce(content,''), ' ') AS t FROM artifacts.artifact
      UNION ALL SELECT string_agg(coalesce(content,''), ' ') FROM artifacts.artifact_version
      UNION ALL SELECT string_agg(encode(raw, 'escape'), ' ') FROM mailbox.principal_mail
      UNION ALL SELECT string_agg(coalesce(status_sealed,''), ' ') FROM inbox_relay.device`));
    const text = Array.from(dump as Iterable<{ t: string | null }>).map((r) => r.t ?? "").join(" ");
    expect(text).not.toContain("SECRET-MARKER-ALPHA");
    expect(text).not.toContain("Maria Chen");
    expect(text).not.toContain("triage.markRead");

    // Revocation cuts access.
    await hub.revokeDevice(enrolledViewer.device.id);
    await expect(viewer.listArtifacts()).rejects.toMatchObject({ status: 403 });
    expect((await viewer.me()).device.wrappedInboxKey).toBeNull();
  });

  test("a stale or forged signature is refused", async () => {
    const keys = await crypto.generateDeviceKeys();
    const c = client(keys);
    await c.enroll({ publicKey: keys.publicKey, label: "x", kind: "viewer" });
    const stale = crypto.signRequest(keys, "GET", "/api/tenants/inbox/me", null, Date.now() - 10 * 60 * 1000);
    const res = await fetchApp("http://relay.test/api/tenants/inbox/me", { headers: { Authorization: stale } });
    expect(res.status).toBe(401);
    const other = await crypto.generateDeviceKeys();
    const forged = crypto.signRequest(other, "GET", "/api/tenants/inbox/me", null).replace(/^Device [^:]+/, `Device ${crypto.deviceIdFor(keys.publicKey)}`);
    const res2 = await fetchApp("http://relay.test/api/tenants/inbox/me", { headers: { Authorization: forged } });
    expect(res2.status).toBe(401);
  });

  test("errors carry the relay's status", async () => {
    const err = await client().me().catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
  });
});
