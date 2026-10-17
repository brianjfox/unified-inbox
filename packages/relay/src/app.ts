import { Hono } from "hono";
import { timeWindowEvaluator } from "@intx/authz";
import { createRequireGrant } from "@intx/hub-api";
import { createArtifactRoutes, InlineContentStore } from "@corbits/artifacts";
import { createInMemoryMailboxEventBus, createMailboxRoutes, resolveMailboxRecipients, writeMailboxMessage } from "@corbits/mailbox";
import { bodyOfFrame, headerOfFrame } from "@inbox/shared/mail";
import type { RelayConfig } from "./config.ts";
import type { Relay } from "./db.ts";
import { createDeviceAuth, requireApproved, type RelayEnv } from "./auth.ts";
import { createDeviceRoutes, createEnrollRoute } from "./devices.ts";
import { createConversationRoutes } from "./conversations.ts";
import { mountGui } from "./gui.ts";

/**
 * The relay: an Interchange-shaped host around the artifacts and mailbox
 * modules (ADR-1). It authenticates devices by signature, confines every
 * route to the one tenant, enforces grants with the hub's own middleware,
 * and serves the GUI (ADR-8). It stores ciphertext and relays it; it holds
 * no key (NFR-2).
 */
export function createRelayApp(relay: Relay, config: RelayConfig): Hono {
  const app = new Hono();
  const tenantId = config.tenant.id;

  const requireGrant = createRequireGrant({
    grantStore: relay.grantStore,
    conditionRegistry: { time_window: timeWindowEvaluator },
  });

  app.get("/api/health", (c) => c.json({ ok: true, service: "unified-inbox-relay", tenant: tenantId, mailDomain: config.tenant.domain, publicOrigin: config.publicOrigin }));

  app.route("/api", createEnrollRoute(relay, tenantId));

  const tenantApp = new Hono<RelayEnv>();
  tenantApp.use("*", createDeviceAuth(relay, tenantId));
  tenantApp.route("/", createDeviceRoutes(relay, tenantId));
  tenantApp.route("/", createConversationRoutes(relay));

  // Everything below is for approved devices only. The modules' own read
  // routes are tenant-scoped without a grant, so approval is enforced here.
  const approvedApp = new Hono<RelayEnv>();
  approvedApp.use("*", requireApproved);
  approvedApp.route("/", createArtifactRoutes({ db: relay.db as never, contentStore: InlineContentStore, requireGrant }));

  const bus = createInMemoryMailboxEventBus();
  approvedApp.route(
    "/mailbox",
    createMailboxRoutes({
      db: relay.db as never,
      bus,
      requireGrant,
      senderAddressFor: ({ principalId }) => `${principalId}@${config.tenant.domain}`,
      // Delivery between devices: the relay files the sealed frame into each
      // recipient's INBOX. It cannot read the body; it only moves it.
      deliver: async (message) => {
        const recipients = resolveMailboxRecipients(message.to, config.tenant.domain);
        const subject = headerOfFrame(message.raw, "Subject") ?? "";
        const body = bodyOfFrame(message.raw);
        for (const r of recipients) {
          await writeMailboxMessage(
            relay.db as never,
            {
              tenantId,
              principalId: r.principalId,
              address: r.address,
              fromAddress: message.from,
              subject,
              body: body.length > 0 ? body : "-",
              messageId: message.messageId,
            },
            bus,
          );
        }
      },
    }),
  );

  tenantApp.route("/", approvedApp);
  app.route(`/api/tenants/${tenantId}`, tenantApp);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  mountGui(app, config.guiDir);
  return app;
}
