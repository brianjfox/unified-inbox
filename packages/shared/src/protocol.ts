import { type } from "arktype";

/**
 * Messages between a viewer and the connector hub. Each travels as one sealed
 * envelope (see crypto.ts) in a mailbox message on the relay. Requests carry an
 * `id`; replies carry `inReplyTo`.
 */

export const HubBoundEvent = type({
  id: "string > 0",
  at: "string",
}).and(
  type.or(
    { type: "'triage.markRead'", conversationIds: "string[]" },
    { type: "'triage.markUnread'", conversationIds: "string[]" },
    { type: "'triage.markAllRead'" },
    { type: "'slack.saveApp'", clientId: "string > 0", clientSecret: "string > 0", appToken: "string > 0" },
    { type: "'slack.startConnect'", redirectUri: "string > 0" },
    { type: "'slack.finishConnect'", code: "string > 0", state: "string > 0", redirectUri: "string > 0" },
    { type: "'slack.removeWorkspace'", teamId: "string > 0" },
    { type: "'whatsapp.link'" },
    { type: "'imessage.setPaused'", paused: "boolean" },
    { type: "'hub.restart'" },
    { type: "'hub.ping'" },
  ),
);
export type HubBoundEvent = typeof HubBoundEvent.infer;

export const ViewerBoundEvent = type({
  id: "string > 0",
  at: "string",
  inReplyTo: "string",
}).and(
  type.or(
    { type: "'reply.ok'" },
    { type: "'reply.error'", message: "string" },
    { type: "'slack.authorizeUrl'", url: "string" },
    { type: "'slack.connected'", teamId: "string", teamName: "string" },
    { type: "'whatsapp.qr'", qr: "string" },
    { type: "'whatsapp.linked'" },
  ),
);
export type ViewerBoundEvent = typeof ViewerBoundEvent.infer;

/** Subject every protocol mail carries, so anything else in the folder is ignored. */
export const PROTOCOL_SUBJECT = "unified-inbox/1";

export function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

/** Artifact kinds the hub writes. Titles are opaque so the relay learns nothing. */
export const CONVERSATION_ARTIFACT_KIND = "inbox.conversation";

export function conversationArtifactTitle(service: string, conversationId: string): string {
  return `${service}:${conversationId}`;
}
