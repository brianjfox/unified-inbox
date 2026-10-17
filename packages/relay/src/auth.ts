import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { schema } from "@intx/db";
import { eq, sql } from "drizzle-orm";
import { parseAuthorization, verifyRequest, ready as sodiumReady } from "@inbox/shared/crypto";
import type { Relay } from "./db.ts";

export type DeviceRow = {
  id: string;
  tenant_id: string;
  principal_id: string;
  public_key: string;
  label: string;
  kind: "hub" | "viewer";
  platform: string;
  approved_at: Date | string | null;
  approved_by: string | null;
  wrapped_inbox_key: string | null;
  revoked_at: Date | string | null;
  last_seen_at: Date | string | null;
  status_sealed: string | null;
  created_at: Date | string;
};

export type RelayEnv = TenantEnv & { Variables: { device: DeviceRow; rawBody: Uint8Array } };

export async function findDevice(relay: Relay, id: string): Promise<DeviceRow | null> {
  const rows = await relay.db.execute(sql`SELECT * FROM inbox_relay.device WHERE id = ${id} LIMIT 1`);
  const list = Array.from(rows as Iterable<DeviceRow>);
  return list[0] ?? null;
}

export function isApproved(d: DeviceRow): boolean {
  return d.approved_at !== null && d.revoked_at === null;
}

/**
 * Authenticates a device by its request signature and puts `tenant`,
 * `principal` and `device` on the context, which is exactly what the
 * artifacts and mailbox sub-apps expect from the hub's own middleware.
 * Pending (unapproved) devices authenticate too; routes that need approval
 * add `requireApproved`.
 */
export function createDeviceAuth(relay: Relay, tenantId: string): MiddlewareHandler<RelayEnv> {
  return async (c, next) => {
    await sodiumReady();
    const parsed = parseAuthorization(c.req.header("authorization"));
    if (!parsed) return c.json({ error: "Device signature required" }, 401);
    const device = await findDevice(relay, parsed.deviceId);
    if (!device || device.tenant_id !== tenantId) return c.json({ error: "Unknown device" }, 401);
    const url = new URL(c.req.url);
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const verified = verifyRequest(parsed, device.public_key, method, url.pathname + url.search, body);
    if (!verified) return c.json({ error: "Device signature invalid or stale" }, 401);
    const tenant = await relay.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);
    const principal = await relay.db.query.principal.findFirst({ where: eq(schema.principal.id, device.principal_id) });
    if (!principal) return c.json({ error: "Principal missing for device" }, 500);
    c.set("user", null);
    c.set("session", null);
    c.set("tenant", tenant as RelayEnv["Variables"]["tenant"]);
    c.set("principal", principal as RelayEnv["Variables"]["principal"]);
    c.set("device", device);
    if (body) c.set("rawBody", body);
    await next();
  };
}

export const requireApproved: MiddlewareHandler<RelayEnv> = async (c, next) => {
  const device = c.get("device");
  if (!isApproved(device)) return c.json({ error: "Device not approved", code: "device_pending" }, 403);
  await next();
};

export const requireHub: MiddlewareHandler<RelayEnv> = async (c, next) => {
  const device = c.get("device");
  if (device.kind !== "hub") return c.json({ error: "Only the hub may do this" }, 403);
  await next();
};
