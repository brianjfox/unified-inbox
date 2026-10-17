import { Hono } from "hono";
import { schema } from "@intx/db";
import { sql } from "drizzle-orm";
import { type } from "arktype";
import { deviceIdFor, ready as sodiumReady } from "@inbox/shared/crypto";
import { DeviceKind } from "@inbox/shared/schema";
import { grantDevice, revokeDeviceGrants, type Relay } from "./db.ts";
import { findDevice, isApproved, requireApproved, requireHub, type DeviceRow, type RelayEnv } from "./auth.ts";

const EnrollBody = type({
  publicKey: "string > 0",
  label: "string > 0",
  kind: DeviceKind,
  "platform?": "string",
});

const ApproveBody = type({ "wrappedInboxKey?": "string > 0" });
const HeartbeatBody = type({ statusSealed: "string > 0" });

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function serializeDevice(d: DeviceRow, opts: { includeWrappedKey: boolean }) {
  return {
    id: d.id,
    principalId: d.principal_id,
    publicKey: d.public_key,
    label: d.label,
    kind: d.kind,
    platform: d.platform,
    approvedAt: iso(d.approved_at),
    ...(opts.includeWrappedKey ? { wrappedInboxKey: d.wrapped_inbox_key } : {}),
    createdAt: iso(d.created_at) ?? new Date().toISOString(),
    lastSeenAt: iso(d.last_seen_at),
    revokedAt: iso(d.revoked_at),
  };
}

async function listDevices(relay: Relay, tenantId: string): Promise<DeviceRow[]> {
  const rows = await relay.db.execute(sql`SELECT * FROM inbox_relay.device WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`);
  return Array.from(rows as Iterable<DeviceRow>);
}

/**
 * Enrollment is the only unauthenticated write: anyone can ask to join, and
 * nothing is readable until an approved device wraps the inbox key for the
 * newcomer. The first hub to enroll is approved automatically because it
 * generates the inbox key itself; it then approves the first viewer (see
 * QUESTIONS.md, bootstrap).
 */
export function createEnrollRoute(relay: Relay, tenantId: string): Hono {
  const app = new Hono();
  app.post("/enroll", async (c) => {
    await sodiumReady();
    const body = EnrollBody(await c.req.json().catch(() => null));
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
    const id = deviceIdFor(body.publicKey);
    const existing = await findDevice(relay, id);
    if (existing) return c.json({ device: serializeDevice(existing, { includeWrappedKey: true }) });

    const hubs = (await listDevices(relay, tenantId)).filter((d) => d.kind === "hub" && isApproved(d));
    const autoApprove = body.kind === "hub" && hubs.length === 0;

    await relay.transaction(async (tx) => {
      await tx.insert(schema.principal).values({ id, tenantId, kind: "user", refId: id, status: "active" });
      await tx.execute(sql`
        INSERT INTO inbox_relay.device (id, tenant_id, principal_id, public_key, label, kind, platform, approved_at, approved_by)
        VALUES (${id}, ${tenantId}, ${id}, ${body.publicKey}, ${body.label}, ${body.kind}, ${body.platform ?? ""}, CASE WHEN ${autoApprove} THEN now() ELSE NULL END, ${autoApprove ? "bootstrap" : null})`);
    });
    if (autoApprove) await grantDevice(relay, tenantId, id);
    const created = await findDevice(relay, id);
    return c.json({ device: serializeDevice(created!, { includeWrappedKey: true }) }, 201);
  });
  return app;
}

/** Authenticated device routes: who am I, who else is enrolled, approve, revoke, hub heartbeat. */
export function createDeviceRoutes(relay: Relay, tenantId: string): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  app.get("/me", async (c) => {
    const device = c.get("device");
    await relay.db.execute(sql`UPDATE inbox_relay.device SET last_seen_at = now() WHERE id = ${device.id}`);
    return c.json({ device: serializeDevice(device, { includeWrappedKey: true }) });
  });

  app.get("/devices", requireApproved, async (c) => {
    const devices = await listDevices(relay, tenantId);
    return c.json({ devices: devices.map((d) => serializeDevice(d, { includeWrappedKey: false })) });
  });

  app.post("/devices/:id/approve", requireApproved, async (c) => {
    const approver = c.get("device");
    const body = ApproveBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
    const target = await findDevice(relay, c.req.param("id"));
    if (!target || target.tenant_id !== tenantId) return c.json({ error: "No such device" }, 404);
    if (target.revoked_at) return c.json({ error: "Device was revoked" }, 409);
    if (target.kind === "viewer" && !body.wrappedInboxKey) return c.json({ error: "A viewer needs the inbox key wrapped for it" }, 400);
    await relay.db.execute(sql`
      UPDATE inbox_relay.device
      SET approved_at = COALESCE(approved_at, now()), approved_by = ${approver.id}, wrapped_inbox_key = COALESCE(${body.wrappedInboxKey ?? null}, wrapped_inbox_key)
      WHERE id = ${target.id}`);
    await grantDevice(relay, tenantId, target.principal_id);
    const updated = await findDevice(relay, target.id);
    return c.json({ device: serializeDevice(updated!, { includeWrappedKey: false }) });
  });

  app.post("/devices/:id/revoke", requireApproved, async (c) => {
    const target = await findDevice(relay, c.req.param("id"));
    if (!target || target.tenant_id !== tenantId) return c.json({ error: "No such device" }, 404);
    await relay.db.execute(sql`UPDATE inbox_relay.device SET revoked_at = COALESCE(revoked_at, now()), wrapped_inbox_key = NULL WHERE id = ${target.id}`);
    await revokeDeviceGrants(relay, tenantId, target.principal_id);
    const updated = await findDevice(relay, target.id);
    return c.json({ device: serializeDevice(updated!, { includeWrappedKey: false }) });
  });

  app.post("/hub/heartbeat", requireApproved, requireHub, async (c) => {
    const device = c.get("device");
    const body = HeartbeatBody(await c.req.json().catch(() => null));
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
    await relay.db.execute(sql`UPDATE inbox_relay.device SET last_seen_at = now(), status_sealed = ${body.statusSealed} WHERE id = ${device.id}`);
    return c.json({ ok: true, at: new Date().toISOString() });
  });

  /** Readable by pending devices too: a viewer waiting for approval still shows hub state. */
  app.get("/hub/status", async (c) => {
    const hubs = (await listDevices(relay, tenantId)).filter((d) => d.kind === "hub" && isApproved(d));
    const hub = hubs.sort((a, b) => (iso(b.last_seen_at) ?? "").localeCompare(iso(a.last_seen_at) ?? ""))[0];
    if (!hub) return c.json({ hub: null });
    return c.json({ hub: { deviceId: hub.id, publicKey: hub.public_key, label: hub.label, lastHeartbeatAt: iso(hub.last_seen_at), statusSealed: hub.status_sealed } });
  });

  return app;
}
