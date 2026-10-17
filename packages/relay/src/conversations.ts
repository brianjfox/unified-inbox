import { Hono } from "hono";
import { type } from "arktype";
import { createArtifact, serializeArtifact } from "@corbits/artifacts";
import { CONVERSATION_ARTIFACT_KIND } from "@inbox/shared/protocol";
import type { Relay } from "./db.ts";
import { requireApproved, requireHub, type RelayEnv } from "./auth.ts";

const CreateBody = type({ title: "string > 0", content: "string > 0" });

/**
 * The one artifact route the package's HTTP surface does not offer: creating
 * an artifact of the relay's own kind, so viewers can list conversations with
 * `GET /artifacts?kind=inbox.conversation`. Revisions, reads and listing go
 * through the package's own routes. Only the hub creates conversations (FR-9).
 */
export function createConversationRoutes(relay: Relay): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();
  app.post("/conversations", requireApproved, requireHub, async (c) => {
    const body = CreateBody(await c.req.json().catch(() => null));
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const row = await relay.db.transaction((tx) =>
      createArtifact(tx as never, {
        scope: { tenantId: tenant.id, principalId: principal.id },
        ownerPrincipalId: principal.id,
        kind: CONVERSATION_ARTIFACT_KIND,
        title: body.title,
        content: body.content,
        source: { origin: "manual", producer: "connector-hub" },
        metadata: null,
      }),
    );
    return c.json({ artifact: serializeArtifact(row) }, 201);
  });
  return app;
}
