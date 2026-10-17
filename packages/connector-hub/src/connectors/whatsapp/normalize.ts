import type { InboxEvent } from "@inbox/shared/schema";

/**
 * Pure translation from a Baileys message to an InboxEvent. No socket, no
 * store: the connector feeds it the names it has learned and gets back the
 * event to hand the hub, or null when the message is not something a person
 * reads (a reaction, a protocol message, a group system event).
 *
 * The types here are our own narrow view of Baileys' loose protobuf shapes;
 * every Baileys WAMessage is assignable to WaMessage without a cast.
 */

export type WaKey = {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
};

/** protobufjs Long: 64-bit as two 32-bit halves. */
export type LongLike = {
  low: number;
  high: number;
  unsigned?: boolean;
  toNumber?: () => number;
};

export type WaTimestamp = number | LongLike | null | undefined;

type Wrapper = { message?: WaContent | null } | null;

export type WaContent = {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  audioMessage?: object | null;
  documentMessage?: { fileName?: string | null; caption?: string | null } | null;
  stickerMessage?: object | null;
  locationMessage?: object | null;
  liveLocationMessage?: object | null;
  contactMessage?: { displayName?: string | null } | null;
  contactsArrayMessage?: object | null;
  reactionMessage?: object | null;
  protocolMessage?: { type?: number | null; editedMessage?: WaContent | null } | null;
  ephemeralMessage?: Wrapper;
  viewOnceMessage?: Wrapper;
  viewOnceMessageV2?: Wrapper;
  viewOnceMessageV2Extension?: Wrapper;
  documentWithCaptionMessage?: Wrapper;
  editedMessage?: Wrapper;
  senderKeyDistributionMessage?: object | null;
  messageContextInfo?: object | null;
};

export type WaMessage = {
  key: WaKey;
  message?: WaContent | null;
  messageTimestamp?: WaTimestamp;
  pushName?: string | null;
  participant?: string | null;
};

export type NormalizeContext = {
  /** The name the connector already knows for the chat (group subject, contact name); undefined to fall back. */
  conversationName?: string | undefined;
  /** Looks up a contact name for a jid (contacts.upsert, chats, learned push names). */
  resolveName?: (jid: string) => string | undefined;
};

export const GROUP_SUFFIX = "@g.us";
export const USER_SUFFIX = "@s.whatsapp.net";

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_SUFFIX);
}

/** Status posts and channels are not conversations with a person. */
export function shouldIgnoreJid(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@newsletter");
}

/** The part before "@", with any device suffix (":12") removed. */
export function jidLocalPart(jid: string): string {
  const at = jid.indexOf("@");
  const local = at === -1 ? jid : jid.slice(0, at);
  const colon = local.indexOf(":");
  return colon === -1 ? local : local.slice(0, colon);
}

/** The digits of the jid's local part, for a display fallback. */
export function jidDigits(jid: string): string {
  return jidLocalPart(jid).replace(/\D/g, "");
}

/** The phone number a jid encodes, when it does; LID and group jids carry none. */
export function jidPhone(jid: string): string | undefined {
  if (!jid.endsWith(USER_SUFFIX)) return undefined;
  const digits = jidDigits(jid);
  return digits.length > 0 ? digits : undefined;
}

export function timestampToSeconds(ts: WaTimestamp): number | undefined {
  if (ts === null || ts === undefined) return undefined;
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : undefined;
  if (typeof ts.toNumber === "function") return ts.toNumber();
  const high = ts.unsigned ? ts.high >>> 0 : ts.high;
  return high * 4294967296 + (ts.low >>> 0);
}

/** WhatsApp timestamps are whole seconds. Falls back to `now` when the message carries none. */
export function timestampToIso(ts: WaTimestamp, now: Date = new Date()): string {
  const seconds = timestampToSeconds(ts);
  if (seconds === undefined || seconds <= 0) return now.toISOString();
  return new Date(seconds * 1000).toISOString();
}

export const HISTORY_WINDOW_DAYS = 14;

/** Whether a history message is recent enough to import. */
export function withinHistoryWindow(sentAtIso: string, now: Date = new Date(), days: number = HISTORY_WINDOW_DAYS): boolean {
  const sentAt = Date.parse(sentAtIso);
  if (Number.isNaN(sentAt)) return false;
  return now.getTime() - sentAt <= days * 24 * 60 * 60 * 1000;
}

/** Peels ephemeral, view-once, edit and document-caption wrappers down to the content they carry. */
export function unwrapContent(content: WaContent | null | undefined): WaContent | null {
  let current: WaContent | null | undefined = content;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const wrapped: Wrapper | undefined =
      current.ephemeralMessage ??
      current.viewOnceMessage ??
      current.viewOnceMessageV2 ??
      current.viewOnceMessageV2Extension ??
      current.documentWithCaptionMessage ??
      current.editedMessage;
    if (wrapped) {
      current = wrapped.message;
      continue;
    }
    if (current.protocolMessage) {
      current = current.protocolMessage.editedMessage ?? null;
      continue;
    }
    return current;
  }
  return current ?? null;
}

const labeled = (label: string, caption: string | null | undefined): string => {
  const text = caption?.trim();
  return text ? `${label} ${text}` : label;
};

/**
 * The text a person would read for this content, or null for content that is
 * not a message in its own right (reactions, protocol and key-distribution
 * messages, messages with nothing left after unwrapping).
 */
export function extractBody(content: WaContent | null | undefined): string | null {
  const m = unwrapContent(content);
  if (!m) return null;
  if (m.reactionMessage) return null;
  if (typeof m.conversation === "string" && m.conversation.length > 0) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return labeled("[photo]", m.imageMessage.caption);
  if (m.videoMessage) return labeled("[video]", m.videoMessage.caption);
  if (m.audioMessage) return "[voice message]";
  if (m.documentMessage) return labeled("[document]", m.documentMessage.fileName ?? m.documentMessage.caption);
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage || m.liveLocationMessage) return "[location]";
  if (m.contactMessage) return labeled("[contact]", m.contactMessage.displayName);
  if (m.contactsArrayMessage) return "[contact]";
  const substantive = Object.entries(m).filter(
    ([k, v]) => v !== null && v !== undefined && k !== "senderKeyDistributionMessage" && k !== "messageContextInfo",
  );
  if (substantive.length === 0) return null;
  return "[message]";
}

/** The jid of whoever sent the message: the group participant, or the chat itself one-to-one. */
export function senderJid(msg: WaMessage): string | undefined {
  return msg.key.participant ?? msg.participant ?? msg.key.remoteJid ?? undefined;
}

export function toInboxEvent(msg: WaMessage, ctx: NormalizeContext = {}, now: Date = new Date()): InboxEvent | null {
  const jid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!jid || !messageId || shouldIgnoreJid(jid)) return null;
  const body = extractBody(msg.message);
  if (body === null) return null;

  const isGroup = isGroupJid(jid);
  const fromMe = msg.key.fromMe === true;
  const resolve = ctx.resolveName ?? (() => undefined);
  const sender = senderJid(msg);
  const pushName = msg.pushName?.trim() || undefined;

  const senderName = fromMe ? "Me" : (sender ? resolve(sender) : undefined) ?? pushName ?? (sender ? jidDigits(sender) : "") ?? "";

  let conversationName = ctx.conversationName?.trim() || resolve(jid);
  if (!conversationName) {
    if (isGroup) conversationName = jidLocalPart(jid);
    else conversationName = (!fromMe ? pushName : undefined) ?? jidDigits(jid) ?? jid;
  }

  const phone = jidPhone(jid);
  return {
    v: 1,
    service: "whatsapp",
    conversationId: jid,
    conversationName,
    isGroup,
    messageId,
    senderName,
    senderIsMe: fromMe,
    body,
    sentAt: timestampToIso(msg.messageTimestamp, now),
    link: { whatsapp: phone ? { jid, phone } : { jid } },
  };
}
