import type { HubStatus } from "@inbox/shared/schema";
import { DisconnectReason } from "@whiskeysockets/baileys";

/**
 * The connection state machine, kept pure so it can be tested without a
 * socket: current status + a Baileys `connection.update` → next status and
 * the one action the connector must take.
 */

export type WhatsAppStatus = HubStatus["whatsapp"];

/** The slice of Baileys' ConnectionState the state machine reads. */
export type ConnectionUpdate = {
  connection?: "open" | "connecting" | "close" | undefined;
  qr?: string | undefined;
  lastDisconnect?: { error: Error | undefined; date: Date } | undefined;
};

export type LifecycleAction =
  | { kind: "none" }
  | { kind: "reconnect"; delayMs: number }
  | { kind: "clear-auth" };

export type LifecycleResult = {
  status: WhatsAppStatus;
  action: LifecycleAction;
  /** True when a link attempt in progress has just completed. */
  linked: boolean;
};

export type LifecycleContext = {
  /** Digits of the linked phone, from creds.me.id, once known. */
  phone?: string | undefined;
  /** How many reconnects have failed in a row; drives the backoff. */
  attempt: number;
  /** When the connection first went down in this outage; undefined when it was up. */
  downSince?: Date | undefined;
  now: Date;
};

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** 1s, 2s, 4s, … capped at 60s. */
export function backoffMs(attempt: number): number {
  const exp = Math.min(Math.max(0, attempt), 16);
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** exp);
}

export const NOT_LINKED_DETAIL =
  "Not linked. Open Connections → WhatsApp → Show QR code, then scan it from your phone to make this Mac WhatsApp's one linked device.";
export const LINKING_DETAIL = "Waiting for a scan. On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the code.";
export const FINISHING_LINK_DETAIL = "Scanned. Finishing the link with WhatsApp…";
export const EXPIRED_DETAIL =
  "The linked-device session ended on WhatsApp's side (this happens periodically). The inbox keeps what it already synced; " +
  "new WhatsApp messages won't arrive until you relink from the Connections screen.";

export function connectedDetail(phone: string | undefined): string {
  return phone ? `Linked as +${phone}. New messages arrive as they reach the phone.` : "Linked. New messages arrive as they reach the phone.";
}

export function connectingDetail(since: Date): string {
  return `Connecting to WhatsApp since ${since.toISOString()}. WhatsApp messages since then are stale until the session is back.`;
}

export function outageDetail(since: Date, code: number | undefined, retryInMs: number): string {
  const reason = code === undefined ? "" : ` (code ${code})`;
  const retry = retryInMs < 1_000 ? "now" : `in ${Math.round(retryInMs / 1_000)}s`;
  return `Connection to WhatsApp lost at ${since.toISOString()}${reason}; reconnecting ${retry}. WhatsApp messages since then are stale until it reconnects.`;
}

/** Baileys wraps the close reason in a Boom error; its HTTP-style status code is the reason. */
export function disconnectStatusCode(lastDisconnect: ConnectionUpdate["lastDisconnect"]): number | undefined {
  const error = lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const code = error?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

export function nextOnConnectionUpdate(current: WhatsAppStatus, update: ConnectionUpdate, ctx: LifecycleContext): LifecycleResult {
  if (update.qr) {
    return { status: { state: "linking", detail: LINKING_DETAIL }, action: { kind: "none" }, linked: false };
  }

  if (update.connection === "open") {
    const status: WhatsAppStatus = { state: "connected", detail: connectedDetail(ctx.phone) };
    if (ctx.phone) status.phone = ctx.phone;
    return { status, action: { kind: "none" }, linked: current.state === "linking" };
  }

  if (update.connection === "close") {
    const code = disconnectStatusCode(update.lastDisconnect);
    if (code === DisconnectReason.loggedOut) {
      return { status: { state: "expired", detail: EXPIRED_DETAIL }, action: { kind: "clear-auth" }, linked: false };
    }
    if (current.state === "linking") {
      // Baileys closes once after a successful scan (restartRequired) and after a run of unscanned QR codes (timedOut);
      // both continue the same link attempt on a fresh socket.
      const detail = code === DisconnectReason.restartRequired ? FINISHING_LINK_DETAIL : LINKING_DETAIL;
      const delayMs = code === DisconnectReason.restartRequired ? 0 : backoffMs(ctx.attempt);
      return { status: { state: "linking", detail }, action: { kind: "reconnect", delayMs }, linked: false };
    }
    const since = ctx.downSince ?? ctx.now;
    const delayMs = code === DisconnectReason.restartRequired ? 0 : backoffMs(ctx.attempt);
    return { status: { state: "error", detail: outageDetail(since, code, delayMs) }, action: { kind: "reconnect", delayMs }, linked: false };
  }

  if (update.connection === "connecting" && current.state !== "linking" && current.state !== "connected") {
    return { status: { state: "error", detail: connectingDetail(ctx.downSince ?? ctx.now) }, action: { kind: "none" }, linked: false };
  }

  return { status: current, action: { kind: "none" }, linked: false };
}
