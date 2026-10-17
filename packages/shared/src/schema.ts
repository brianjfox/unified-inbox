import { type } from "arktype";

/** The services this version connects. Adding one later is one more literal here. */
export const Service = type("'imessage' | 'slack' | 'whatsapp'");
export type Service = typeof Service.infer;
export const SERVICES: readonly Service[] = ["imessage", "slack", "whatsapp"];

/**
 * One normalized message, as a connector emits it. Versioned so a viewer on an
 * older build refuses rather than misreads a newer shape.
 */
export const InboxEvent = type({
  v: "1",
  service: Service,
  /** Stable per service: Slack channel id, WhatsApp JID, iMessage chat guid. */
  conversationId: "string > 0",
  conversationName: "string",
  isGroup: "boolean",
  /** Slack team id for Slack conversations; undefined otherwise. */
  "workspaceId?": "string",
  "workspaceName?": "string",
  /** Stable per service: Slack ts, WhatsApp message id, iMessage guid. */
  messageId: "string > 0",
  senderName: "string",
  senderIsMe: "boolean",
  body: "string",
  /** ISO 8601. */
  sentAt: "string",
  /** Service-specific identifiers the viewer's deep-link resolver needs. */
  link: {
    "slack?": { teamId: "string", channelId: "string", "teamDomain?": "string" },
    "whatsapp?": { jid: "string", "phone?": "string" },
    "imessage?": { handles: "string[]", chatGuid: "string" },
  },
});
export type InboxEvent = typeof InboxEvent.infer;

export const StoredMessage = type({
  id: "string > 0",
  senderName: "string",
  senderIsMe: "boolean",
  body: "string",
  sentAt: "string",
});
export type StoredMessage = typeof StoredMessage.infer;

/**
 * The sealed content of one conversation artifact: everything a viewer needs
 * to render the row, the thread, and the Reply button. The hub is its only
 * writer; every message arrival or read-state change is a new version.
 */
export const ConversationState = type({
  v: "1",
  service: Service,
  conversationId: "string > 0",
  name: "string",
  isGroup: "boolean",
  "workspaceId?": "string",
  "workspaceName?": "string",
  messages: StoredMessage.array(),
  lastMessageAt: "string",
  /** Preview line: the last message, prefixed with the sender in a group. */
  preview: "string",
  unread: "boolean",
  unreadCount: "number >= 0",
  "readAt?": "string",
  link: InboxEvent.get("link"),
});
export type ConversationState = typeof ConversationState.infer;

/** How many messages a conversation artifact keeps; older ones fall off. */
export const MESSAGES_PER_CONVERSATION = 200;

export const SlackWorkspaceStatus = type({
  teamId: "string",
  name: "string",
  authorizedAt: "string",
  connected: "boolean",
  "error?": "string",
});
export type SlackWorkspaceStatus = typeof SlackWorkspaceStatus.infer;

/**
 * The hub's sealed status, sent with every heartbeat. The relay stores it
 * without reading it and keeps only the timestamp in the clear.
 */
export const HubStatus = type({
  v: "1",
  at: "string",
  hubName: "string",
  version: "string",
  imessage: {
    state: "'connected' | 'no-full-disk-access' | 'paused' | 'error' | 'unavailable'",
    detail: "string",
    readBack: "'per-conversation' | 'unavailable'",
  },
  slack: {
    state: "'connected' | 'not-configured' | 'no-workspaces' | 'error'",
    detail: "string",
    appConfigured: "boolean",
    workspaces: SlackWorkspaceStatus.array(),
  },
  whatsapp: {
    state: "'not-linked' | 'linking' | 'connected' | 'expired' | 'error'",
    detail: "string",
    "phone?": "string",
  },
});
export type HubStatus = typeof HubStatus.infer;

export const DeviceKind = type("'hub' | 'viewer'");
export type DeviceKind = typeof DeviceKind.infer;

/** A device as the relay lists it. Public information only. */
export const DeviceRecord = type({
  id: "string",
  principalId: "string",
  publicKey: "string",
  label: "string",
  kind: DeviceKind,
  platform: "string",
  approvedAt: "string | null",
  "wrappedInboxKey?": "string | null",
  createdAt: "string",
  lastSeenAt: "string | null",
  revokedAt: "string | null",
});
export type DeviceRecord = typeof DeviceRecord.infer;

export function previewFor(state: Pick<ConversationState, "isGroup" | "messages">): string {
  const last = state.messages[state.messages.length - 1];
  if (!last) return "";
  const body = last.body.replace(/\s+/g, " ").trim();
  if (state.isGroup && !last.senderIsMe) return `${last.senderName}: ${body}`;
  return body;
}
