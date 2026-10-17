import { createDB, createGrantStore, runMigrations, schema, type DBConfig } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import { runMailboxMigrations } from "@corbits/mailbox";
import { sql, eq, and } from "drizzle-orm";
import { ready as sodiumReady, randomToken } from "@inbox/shared/crypto";
import type { RelayConfig } from "./config.ts";

export type Relay = ReturnType<typeof createDB> & { grantStore: ReturnType<typeof createGrantStore> };

/**
 * Boots the database: Interchange's own migrations, then the artifacts and
 * mailbox modules' migrations, then the relay's device table. Every step is
 * idempotent, so this runs on every start (the provisioning script relies on
 * that: a rerun is the upgrade path).
 */
export async function migrate(config: DBConfig): Promise<void> {
  // Interchange's own runner replays every migration file and keeps no ledger,
  // so it runs once per database; the relay records that it ran. The artifacts
  // and mailbox runners are idempotent and run every start.
  await ensureIntxMigrations(config);
  await runArtifactMigrations(config, { schema: "public" });
  await runMailboxMigrations(config, { schema: "public" });
  const { db, close } = createDB(config);
  try {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS inbox_relay`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS inbox_relay.device (
        id text PRIMARY KEY,
        tenant_id text NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
        principal_id text NOT NULL REFERENCES public.principal(id) ON DELETE CASCADE,
        public_key text NOT NULL UNIQUE,
        label text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('hub','viewer')),
        platform text NOT NULL DEFAULT '',
        approved_at timestamptz,
        approved_by text,
        wrapped_inbox_key text,
        revoked_at timestamptz,
        last_seen_at timestamptz,
        status_sealed text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
  } finally {
    await close();
  }
}

const INTX_DB_VERSION = "0.5.0";

async function ensureIntxMigrations(config: DBConfig): Promise<void> {
  const { db, close } = createDB(config);
  try {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS inbox_relay`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS inbox_relay.ledger (name text PRIMARY KEY, version text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const rows = Array.from((await db.execute(sql`SELECT version FROM inbox_relay.ledger WHERE name = 'intx-db'`)) as Iterable<{ version: string }>);
    const applied = rows[0]?.version;
    if (applied === INTX_DB_VERSION) return;
    if (applied && applied !== INTX_DB_VERSION) {
      throw new Error(
        `The database was migrated by @intx/db ${applied} and this relay bundles ${INTX_DB_VERSION}. Interchange's migration runner cannot upgrade in place; restore from a fresh database (every conversation is re-synced by the hub) or pin @intx/db to ${applied}.`,
      );
    }
    const tenantTable = Array.from((await db.execute(sql`SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant'`)) as Iterable<unknown>);
    if (tenantTable.length === 0) await runMigrations(config, { schema: "public" });
    await db.execute(sql`INSERT INTO inbox_relay.ledger(name, version) VALUES ('intx-db', ${INTX_DB_VERSION}) ON CONFLICT (name) DO UPDATE SET version = excluded.version, applied_at = now()`);
  } finally {
    await close();
  }
}

export function openRelayDb(config: DBConfig): Relay {
  const handle = createDB(config);
  return { ...handle, grantStore: createGrantStore(handle.db) };
}

/** Ensures the single tenant row exists. */
export async function ensureTenant(relay: Relay, tenant: RelayConfig["tenant"]): Promise<void> {
  await sodiumReady();
  await relay.db
    .insert(schema.tenant)
    .values({ id: tenant.id, name: tenant.name, slug: tenant.slug, domain: tenant.domain, parentId: null, config: null })
    .onConflictDoUpdate({ target: schema.tenant.id, set: { domain: tenant.domain, name: tenant.name } });
}

export const DEVICE_GRANTS: ReadonlyArray<{ resource: string; action: string }> = [
  { resource: "mailbox:*", action: "read" },
  { resource: "mailbox:*", action: "create" },
  { resource: "mailbox:*", action: "manage" },
  { resource: "artifact:*", action: "create" },
  { resource: "artifact:*", action: "write" },
  { resource: "artifact:*", action: "archive" },
  { resource: "device:*", action: "manage" },
];

/** Grants an approved device everything a viewer or the hub needs. Idempotent. */
export async function grantDevice(relay: Relay, tenantId: string, principalId: string): Promise<void> {
  for (const g of DEVICE_GRANTS) {
    const existing = await relay.db
      .select({ id: schema.grant.id })
      .from(schema.grant)
      .where(and(eq(schema.grant.tenantId, tenantId), eq(schema.grant.principalId, principalId), eq(schema.grant.resource, g.resource), eq(schema.grant.action, g.action)))
      .limit(1);
    if (existing.length > 0) continue;
    await relay.db.insert(schema.grant).values({
      id: `grt_${randomToken(12)}`,
      tenantId,
      principalId,
      roleId: null,
      resource: g.resource,
      action: g.action,
      effect: "allow",
      conditions: null,
      origin: "system",
      expiresAt: null,
    });
  }
}

export async function revokeDeviceGrants(relay: Relay, tenantId: string, principalId: string): Promise<void> {
  await relay.db.delete(schema.grant).where(and(eq(schema.grant.tenantId, tenantId), eq(schema.grant.principalId, principalId)));
}
