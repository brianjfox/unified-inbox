/**
 * The shapes the Slack connector reads off the wire: Socket Mode envelopes
 * and the `message` events inside them. Slack's SDK types these loosely, so
 * the guards here turn `unknown` into the fields the connector relies on.
 */

/** What `SocketModeClient` emits on `slack_event` for every envelope. */
export type SocketModeEnvelope = {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  type: string;
  body: unknown;
  envelope_id?: string;
  retry_num?: number;
  retry_reason?: string;
};

export type SlackChannelType = "im" | "mpim";

/** A `message` event, as Slack sends it over the Events API or returns it from `conversations.history`. */
export type SlackMessage = {
  type: "message";
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  team?: string;
  hidden?: boolean;
  files?: unknown[];
};

export type EventsApiBody = {
  team_id?: string;
  event?: unknown;
  authorizations?: Array<{ team_id?: string }>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Subtypes that still carry a message a person wrote. Everything else
 * (message_changed, message_deleted, channel_join, bot_message, ...) is an
 * edit, a tombstone or a system line and is not an inbox message.
 */
const PERSON_MESSAGE_SUBTYPES: ReadonlySet<string | undefined> = new Set([undefined, "file_share", "thread_broadcast", "me_message"]);

export type MessageClassification = { message: SlackMessage } | { ignored: string };

/** Decides whether `raw` is a direct message a person sent, or says why it is not. */
export function classifyMessage(raw: unknown): MessageClassification {
  if (!isRecord(raw)) return { ignored: "not an object" };
  if (raw.type !== "message") return { ignored: `event type ${String(raw.type)}` };
  if (typeof raw.ts !== "string" || raw.ts.length === 0) return { ignored: "no ts" };
  const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
  if (!PERSON_MESSAGE_SUBTYPES.has(subtype)) return { ignored: `subtype ${subtype}` };
  if (typeof raw.bot_id === "string" && raw.bot_id.length > 0) return { ignored: "bot message" };
  if (raw.hidden === true) return { ignored: "hidden" };
  if (typeof raw.user !== "string" || raw.user.length === 0) return { ignored: "no user" };
  const message: SlackMessage = {
    type: "message",
    ts: raw.ts,
    user: raw.user,
    ...(subtype ? { subtype } : {}),
    ...(typeof raw.channel === "string" ? { channel: raw.channel } : {}),
    ...(typeof raw.channel_type === "string" ? { channel_type: raw.channel_type } : {}),
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(typeof raw.team === "string" ? { team: raw.team } : {}),
    ...(Array.isArray(raw.files) ? { files: raw.files } : {}),
  };
  return { message };
}

export function asChannelType(value: string | undefined): SlackChannelType | null {
  return value === "im" || value === "mpim" ? value : null;
}

/** Reads the Events API body of a Socket Mode envelope, or null when it is not one. */
export function asEventsApiBody(body: unknown): EventsApiBody | null {
  if (!isRecord(body)) return null;
  const out: EventsApiBody = {};
  if (typeof body.team_id === "string") out.team_id = body.team_id;
  if ("event" in body) out.event = body.event;
  if (Array.isArray(body.authorizations)) {
    out.authorizations = body.authorizations.filter(isRecord).map((a) => (typeof a.team_id === "string" ? { team_id: a.team_id } : {}));
  }
  return out;
}

/** The workspace an envelope belongs to: the body's team, else the event's, else the first authorization's. */
export function teamIdOf(body: EventsApiBody, message: SlackMessage): string | null {
  return body.team_id ?? message.team ?? body.authorizations?.[0]?.team_id ?? null;
}
