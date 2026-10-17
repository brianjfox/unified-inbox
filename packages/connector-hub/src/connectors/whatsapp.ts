import pino from "pino";
import { makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from "@whiskeysockets/baileys";
import type { Chat, ChatUpdate, Contact, GroupMetadata, WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { HubConfig } from "../config.ts";
import type { Keychain } from "../keychain.ts";
import type { HubStore } from "../store.ts";
import type { ConnectorHost, Logger, WhatsAppConnector } from "./types.ts";
import {
  WHATSAPP_AUTH_KEYCHAIN_ITEM,
  authKeyFromString,
  authKeyToString,
  generateAuthKey,
  hasLinkedSession,
  useEncryptedSqliteAuthState,
  type EncryptedAuthState,
} from "./whatsapp/auth-state.ts";
import {
  NOT_LINKED_DETAIL,
  LINKING_DETAIL,
  connectingDetail,
  nextOnConnectionUpdate,
  type ConnectionUpdate,
  type WhatsAppStatus,
} from "./whatsapp/lifecycle.ts";
import {
  isGroupJid,
  jidDigits,
  jidLocalPart,
  shouldIgnoreJid,
  timestampToIso,
  toInboxEvent,
  withinHistoryWindow,
  type WaKey,
  type WaMessage,
} from "./whatsapp/normalize.ts";

export { useEncryptedSqliteAuthState } from "./whatsapp/auth-state.ts";
export { toInboxEvent } from "./whatsapp/normalize.ts";
export { nextOnConnectionUpdate } from "./whatsapp/lifecycle.ts";

/**
 * The WhatsApp connector (FR-4, FR-18, task 7, ADR-4): one Baileys
 * linked-device session whose credentials live encrypted in the hub database
 * under a key held only in the keychain. It reports its session state for the
 * Connections card, streams QR codes to the viewer that asked to link, turns
 * incoming messages into InboxEvents, and writes read receipts back.
 */

type LinkHandlers = Parameters<WhatsAppConnector["link"]>[0];

type ActiveLink = {
  handlers: LinkHandlers;
  active: boolean;
};

/** How many incoming message keys per chat are kept for the read receipt. */
const UNREAD_KEYS_PER_CHAT = 20;

const KV_GROUP_NAME = "whatsapp:group-name:";
const KV_CONTACT_NAME = "whatsapp:contact-name:";
const KV_PUSH_NAME = "whatsapp:push-name:";
const KV_UNREAD_KEYS = "whatsapp:unread-keys:";

export function createWhatsAppConnector(deps: { host: ConnectorHost; store: HubStore; keychain: Keychain; config: HubConfig; log: Logger }): WhatsAppConnector {
  const { host, store, keychain, log } = deps;
  const baileysLog = pino({ level: "warn" });

  let status: WhatsAppStatus = { state: "not-linked", detail: NOT_LINKED_DETAIL };
  let auth: EncryptedAuthState | null = null;
  let sock: WASocket | null = null;
  /** Each socket gets a generation; events from an older socket are ignored. */
  let generation = 0;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let downSince: Date | undefined;
  let link: ActiveLink | null = null;

  const groupNames = new Map<string, string>();
  const contactNames = new Map<string, string>();
  const pushNames = new Map<string, string>();
  const unreadKeys = new Map<string, WaKey[]>();

  // ---- status -------------------------------------------------------------

  const setStatus = (next: WhatsAppStatus): void => {
    const changed = next.state !== status.state;
    status = next;
    if (changed) {
      log.info("whatsapp session state", { state: next.state });
      host.onStatusChanged();
    }
  };

  // ---- names ---------------------------------------------------------------

  const cached = (map: Map<string, string>, prefix: string, jid: string): string | undefined => {
    const inMemory = map.get(jid);
    if (inMemory !== undefined) return inMemory;
    const stored = store.getKv(prefix + jid);
    if (stored !== null) map.set(jid, stored);
    return stored ?? undefined;
  };

  const remember = (map: Map<string, string>, prefix: string, jid: string, name: string): boolean => {
    const previous = cached(map, prefix, jid);
    if (previous === name) return false;
    map.set(jid, name);
    store.setKv(prefix + jid, name);
    return true;
  };

  /** The best name for a one-to-one chat or a sender: saved contact, then their push name. */
  const resolveName = (jid: string): string | undefined =>
    cached(contactNames, KV_CONTACT_NAME, jid) ?? cached(pushNames, KV_PUSH_NAME, jid);

  const conversationNameFor = (jid: string): string | undefined =>
    isGroupJid(jid) ? cached(groupNames, KV_GROUP_NAME, jid) : resolveName(jid);

  const learnContactName = (jid: string, name: string | null | undefined): void => {
    const trimmed = name?.trim();
    if (!trimmed || shouldIgnoreJid(jid)) return;
    if (isGroupJid(jid)) {
      if (remember(groupNames, KV_GROUP_NAME, jid, trimmed)) host.onConversationRenamed("whatsapp", jid, trimmed);
      return;
    }
    if (remember(contactNames, KV_CONTACT_NAME, jid, trimmed)) host.onConversationRenamed("whatsapp", jid, trimmed);
  };

  const learnPushName = (jid: string, pushName: string | null | undefined): void => {
    const trimmed = pushName?.trim();
    if (!trimmed || isGroupJid(jid)) return;
    const hadContactName = cached(contactNames, KV_CONTACT_NAME, jid) !== undefined;
    if (remember(pushNames, KV_PUSH_NAME, jid, trimmed) && !hadContactName) host.onConversationRenamed("whatsapp", jid, trimmed);
  };

  const groupName = async (socket: WASocket, jid: string): Promise<string | undefined> => {
    const known = cached(groupNames, KV_GROUP_NAME, jid);
    if (known !== undefined) return known;
    try {
      const meta: GroupMetadata = await socket.groupMetadata(jid);
      const subject = meta.subject?.trim();
      if (subject) {
        remember(groupNames, KV_GROUP_NAME, jid, subject);
        return subject;
      }
      return undefined;
    } catch (err) {
      log.warn("group metadata lookup failed; using the group id until it succeeds", { jid, error: String(err) });
      return undefined;
    }
  };

  // ---- unread keys for read receipts ----------------------------------------

  const unreadFor = (jid: string): WaKey[] => {
    const inMemory = unreadKeys.get(jid);
    if (inMemory) return inMemory;
    const stored = store.getKv(KV_UNREAD_KEYS + jid);
    const parsed = stored ? (JSON.parse(stored) as WaKey[]) : [];
    unreadKeys.set(jid, parsed);
    return parsed;
  };

  const rememberUnread = (jid: string, key: WaKey): void => {
    const list = unreadFor(jid).filter((k) => k.id !== key.id);
    list.push({ remoteJid: key.remoteJid, id: key.id, fromMe: false, ...(key.participant ? { participant: key.participant } : {}) });
    if (list.length > UNREAD_KEYS_PER_CHAT) list.splice(0, list.length - UNREAD_KEYS_PER_CHAT);
    unreadKeys.set(jid, list);
    store.setKv(KV_UNREAD_KEYS + jid, JSON.stringify(list));
  };

  const clearUnread = (jid: string): void => {
    unreadKeys.set(jid, []);
    store.deleteKv(KV_UNREAD_KEYS + jid);
  };

  // ---- messages --------------------------------------------------------------

  const ingest = async (socket: WASocket, messages: WAMessage[], isHistory: boolean): Promise<void> => {
    const now = new Date();
    for (const raw of messages) {
      const msg: WaMessage = raw;
      const jid = msg.key.remoteJid;
      if (!jid || shouldIgnoreJid(jid)) continue;
      const sentAt = timestampToIso(msg.messageTimestamp, now);
      if (isHistory && !withinHistoryWindow(sentAt, now)) continue;

      const isGroup = isGroupJid(jid);
      if (!isGroup && !msg.key.fromMe) learnPushName(jid, msg.pushName);
      const conversationName = isGroup ? await groupName(socket, jid) : conversationNameFor(jid);
      const event = toInboxEvent(msg, { conversationName, resolveName }, now);
      if (!event) continue;
      host.onMessage(event);
      if (!msg.key.fromMe) rememberUnread(jid, msg.key);
    }
  };

  const onContacts = (contacts: Array<Partial<Contact>>): void => {
    for (const c of contacts) {
      if (!c.id) continue;
      learnContactName(c.id, c.name ?? c.notify);
    }
  };

  const onChats = (chats: Array<Chat | ChatUpdate>): void => {
    for (const c of chats) {
      if (!c.id) continue;
      learnContactName(c.id, c.name);
    }
  };

  // ---- socket lifecycle ---------------------------------------------------------

  const clearReconnect = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSocket = (): void => {
    generation += 1;
    const current = sock;
    sock = null;
    if (!current) return;
    try {
      current.end(undefined);
    } catch (err) {
      log.warn("closing the WhatsApp socket failed", { error: String(err) });
    }
  };

  const loadAuthKey = async (): Promise<Uint8Array> => {
    const existing = await keychain.get(WHATSAPP_AUTH_KEYCHAIN_ITEM);
    if (existing) return authKeyFromString(existing);
    const fresh = await generateAuthKey();
    await keychain.set(WHATSAPP_AUTH_KEYCHAIN_ITEM, authKeyToString(fresh));
    log.info("generated the WhatsApp auth key in the keychain", { item: WHATSAPP_AUTH_KEYCHAIN_ITEM });
    return fresh;
  };

  const loadAuth = async (): Promise<EncryptedAuthState> => {
    const key = await loadAuthKey();
    auth = await useEncryptedSqliteAuthState(store, key);
    return auth;
  };

  const phoneDigits = (): string | undefined => {
    const id = auth?.state.creds.me?.id;
    return id ? jidDigits(id) || undefined : undefined;
  };

  const scheduleReconnect = (delayMs: number): void => {
    clearReconnect();
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      void openSocket();
    }, delayMs);
  };

  const finishLink = (): void => {
    if (!link?.active) return;
    const { handlers } = link;
    link = null;
    handlers.onLinked();
  };

  const failLink = (message: string): void => {
    if (!link?.active) return;
    const { handlers } = link;
    link = null;
    handlers.onError(message);
  };

  const onConnectionUpdate = async (gen: number, update: ConnectionUpdate): Promise<void> => {
    if (gen !== generation || stopped) return;
    const result = nextOnConnectionUpdate(status, update, { phone: phoneDigits(), attempt: reconnectAttempt, downSince, now: new Date() });

    if (update.qr && link?.active) link.handlers.onQr(update.qr);

    if (update.connection === "open") {
      reconnectAttempt = 0;
      downSince = undefined;
      if (auth) await auth.saveCreds();
    } else if (update.connection === "close" && downSince === undefined) {
      downSince = update.lastDisconnect?.date ?? new Date();
    }

    setStatus(result.status);
    if (result.linked) finishLink();

    switch (result.action.kind) {
      case "none":
        return;
      case "clear-auth": {
        log.warn("WhatsApp logged this device out; the session must be relinked");
        closeSocket();
        clearReconnect();
        store.whatsappAuthClear();
        auth = null;
        failLink("WhatsApp ended the session before the link finished. Show the QR code again to retry.");
        return;
      }
      case "reconnect": {
        closeSocket();
        log.warn("WhatsApp connection closed; reconnecting", { delayMs: result.action.delayMs, attempt: reconnectAttempt });
        scheduleReconnect(result.action.delayMs);
        return;
      }
    }
  };

  const openSocket = async (): Promise<void> => {
    if (stopped) return;
    closeSocket();
    const state = auth ?? (await loadAuth());
    const gen = generation;
    try {
      // Baileys falls back to its bundled version when the lookup fails; the timeout keeps a stalled lookup from holding up hub startup.
      const { version } = await fetchLatestBaileysVersion({ timeout: 10_000 });
      if (gen !== generation || stopped) return;
      const socket = makeWASocket({
        version,
        auth: { creds: state.state.creds, keys: makeCacheableSignalKeyStore(state.state.keys, baileysLog) },
        logger: baileysLog,
        browser: Browsers.macOS("Unified Inbox"),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
        cachedGroupMetadata: async () => undefined,
      });
      sock = socket;

      socket.ev.on("creds.update", () => {
        void state.saveCreds().catch((err) => log.error("saving WhatsApp credentials failed", { error: String(err) }));
      });
      socket.ev.on("connection.update", (update) => {
        void onConnectionUpdate(gen, update).catch((err) => log.error("handling a WhatsApp connection update failed", { error: String(err) }));
      });
      socket.ev.on("messages.upsert", ({ messages, type }) => {
        if (gen !== generation) return;
        void ingest(socket, messages, type === "append").catch((err) => log.error("handling WhatsApp messages failed", { error: String(err) }));
      });
      socket.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
        if (gen !== generation) return;
        onContacts(contacts);
        onChats(chats);
        void ingest(socket, messages, true).catch((err) => log.error("handling WhatsApp history failed", { error: String(err) }));
      });
      socket.ev.on("contacts.upsert", (contacts) => {
        if (gen === generation) onContacts(contacts);
      });
      socket.ev.on("contacts.update", (contacts) => {
        if (gen === generation) onContacts(contacts);
      });
      socket.ev.on("chats.upsert", (chats) => {
        if (gen === generation) onChats(chats);
      });
      socket.ev.on("chats.update", (chats) => {
        if (gen === generation) onChats(chats);
      });
      socket.ev.on("groups.update", (groups) => {
        if (gen !== generation) return;
        for (const g of groups) if (g.id) learnContactName(g.id, g.subject);
      });
      socket.ev.on("groups.upsert", (groups) => {
        if (gen !== generation) return;
        for (const g of groups) learnContactName(g.id, g.subject);
      });
    } catch (err) {
      if (gen !== generation || stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      log.error("opening the WhatsApp socket failed", { error: message });
      downSince ??= new Date();
      setStatus({ state: link?.active ? "linking" : "error", detail: link?.active ? LINKING_DETAIL : connectingDetail(downSince) });
      scheduleReconnect(Math.min(60_000, 1_000 * 2 ** reconnectAttempt));
    }
  };

  // ---- the connector ---------------------------------------------------------------

  return {
    service: "whatsapp",

    status: () => ({ ...status }),

    async start() {
      stopped = false;
      let state: EncryptedAuthState;
      try {
        state = await loadAuth();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ state: "error", detail: `WhatsApp credentials could not be opened: ${message}` });
        throw err;
      }
      if (!hasLinkedSession(state.state.creds)) {
        setStatus({ state: "not-linked", detail: NOT_LINKED_DETAIL });
        return;
      }
      downSince = new Date();
      setStatus({ state: "error", detail: connectingDetail(downSince) });
      await openSocket();
    },

    async stop() {
      stopped = true;
      clearReconnect();
      link = null;
      closeSocket();
    },

    async link(handlers) {
      if (link?.active) {
        const previous = link;
        link = null;
        previous.handlers.onError("Another viewer started a new WhatsApp link; this QR code is no longer valid.");
      }
      clearReconnect();
      stopped = false;

      // Start from a clean slate: one session anywhere (FR-4). When a live session exists,
      // ask WhatsApp to drop this device so the phone does not keep a stale linked device.
      if (sock && status.state === "connected") {
        const live = sock;
        generation += 1;
        sock = null;
        try {
          await live.logout("Relinking from the Unified Inbox Connections screen");
        } catch (err) {
          log.warn("logging out the previous WhatsApp session failed; dropping it locally", { error: String(err) });
          try {
            live.end(undefined);
          } catch (endErr) {
            log.warn("closing the previous WhatsApp socket failed", { error: String(endErr) });
          }
        }
      } else {
        closeSocket();
      }
      store.whatsappAuthClear();
      auth = null;
      reconnectAttempt = 0;
      downSince = undefined;

      const attempt: ActiveLink = { handlers, active: true };
      link = attempt;
      setStatus({ state: "linking", detail: LINKING_DETAIL });
      await openSocket();

      return () => {
        if (!attempt.active) return;
        attempt.active = false;
        if (link === attempt) link = null;
        if (status.state !== "connected") {
          clearReconnect();
          closeSocket();
          setStatus({ state: "not-linked", detail: NOT_LINKED_DETAIL });
        }
      };
    },

    async markRead(conversationId) {
      if (!sock || status.state !== "connected") {
        throw new Error("WhatsApp is not connected; the hub cannot mark this conversation read in WhatsApp until the session is back.");
      }
      const keys = unreadFor(conversationId);
      if (keys.length === 0) return;
      await sock.readMessages(keys);
      clearUnread(conversationId);
    },
  };
}
