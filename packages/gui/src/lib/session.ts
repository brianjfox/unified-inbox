import { type } from "arktype";
import * as crypto from "@inbox/shared/crypto";
import { RelayClient, RelayError, type HubStatusRecord } from "@inbox/shared/relay-client";
import { HubStatus, type DeviceRecord } from "@inbox/shared/schema";
import { HubBoundEvent, ViewerBoundEvent, newEventId } from "@inbox/shared/protocol";
import { ConversationCache } from "../db/cache.ts";
import { CacheUnavailableError } from "../db/protocol.ts";
import { kvGet, kvSet } from "./idb.ts";
import { currentPlatform, defaultDeviceLabel } from "./platform.ts";
import { pullChanges } from "./sync.ts";
import { isHubOffline, type HubReading } from "./hub.ts";
import { slackRedirectUri } from "./oauth.ts";
import { store } from "./store.ts";

const KEY_DEVICE_KEYS = "deviceKeys";
const KEY_INBOX_KEY = "inboxKey";
const META_LAST_SYNCED = "lastSyncedAt";

const SYNC_MS = 10_000;
const HUB_STATUS_MS = 10_000;
const MAILBOX_MS = 3_000;
const APPROVAL_POLL_MS = 3_000;
const HEALTH_RETRY_MS = 5_000;
const REPLY_TIMEOUT_MS = 60_000;

type EventBody = HubBoundEvent extends infer E ? (E extends { id: string; at: string } ? Omit<E, "id" | "at"> : never) : never;

type Subscriber = (event: ViewerBoundEvent) => "done" | "keep";
type Pending = { onEvent: Subscriber; onTimeout: () => void; timer: number };

export class HubReplyError extends Error {}
export class HubOfflineError extends Error {
  constructor() {
    super("The Mac hub is unreachable, so this action is unavailable until it is back.");
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNetworkFailure(err: unknown): boolean {
  return !(err instanceof RelayError) || err.status === 0 || err.status >= 500;
}

/**
 * The viewer's session: this device's identity, the relay client, the local
 * cache, and the three loops (sync, hub status, mailbox). Components call its
 * methods; it writes everything they render into the store.
 */
export class Session {
  private relay: RelayClient | null = null;
  private keys: crypto.DeviceKeys | null = null;
  private inboxKey: string | null = null;
  private cache: ConversationCache | null = null;
  private mailDomain = "";
  private readonly pending = new Map<string, Pending>();
  private timers: number[] = [];
  private stopped = false;
  private syncing = false;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.boot();
    } catch (err) {
      store.set({ phase: { kind: "fatal", title: "The inbox could not start", message: errText(err) } });
    }
  }

  private async boot(): Promise<void> {
    await crypto.ready();
    const platform = await currentPlatform();
    store.set({ platform });

    let keys = await kvGet<crypto.DeviceKeys>(KEY_DEVICE_KEYS);
    if (!keys) {
      keys = await crypto.generateDeviceKeys();
      await kvSet(KEY_DEVICE_KEYS, keys);
    }
    this.keys = keys;
    const deviceId = crypto.deviceIdFor(keys.publicKey);
    store.set({ deviceId });

    const origin = window.location.origin;
    const probe = new RelayClient({ baseUrl: origin });
    let health: Awaited<ReturnType<RelayClient["health"]>> | null = null;
    while (!health) {
      try {
        health = await probe.health();
      } catch {
        store.set({ phase: { kind: "unreachable" } });
        await this.sleep(HEALTH_RETRY_MS);
      }
    }
    this.mailDomain = health.mailDomain;
    store.set({ mailDomain: health.mailDomain, phase: { kind: "booting" } });
    const relay = new RelayClient({ baseUrl: origin, tenantId: health.tenant, keys });
    this.relay = relay;

    try {
      this.cache = await ConversationCache.open();
    } catch (err) {
      if (err instanceof CacheUnavailableError && err.code === "opfs-unavailable") {
        store.set({ phase: { kind: "fatal", title: "This browser can't store the inbox", message: err.message } });
        return;
      }
      throw err;
    }

    let inboxKey: string | null = (await kvGet<string>(KEY_INBOX_KEY)) ?? null;
    if (!inboxKey) {
      inboxKey = await this.enrollAndAwaitApproval(relay, keys, platform);
      if (!inboxKey) return;
      await kvSet(KEY_INBOX_KEY, inboxKey);
    }
    this.inboxKey = inboxKey;

    const cache = this.cache;
    const rows = await cache.list();
    const lastSyncedAt = await cache.getMeta(META_LAST_SYNCED);
    store.set({ conversations: rows, lastSyncedAt: lastSyncedAt ?? null, firstSyncDone: rows.length > 0, phase: { kind: "ready" } });

    this.every(HUB_STATUS_MS, () => this.refreshHubStatus());
    this.every(SYNC_MS, () => this.syncNow());
    this.every(MAILBOX_MS, () => this.pollMailbox());
  }

  private async enrollAndAwaitApproval(relay: RelayClient, keys: crypto.DeviceKeys, platform: string): Promise<string | null> {
    let device: DeviceRecord | null = null;
    for (;;) {
      try {
        device = (await relay.me()).device;
        break;
      } catch (err) {
        if (err instanceof RelayError && err.status === 401) {
          try {
            device = (await relay.enroll({ publicKey: keys.publicKey, label: defaultDeviceLabel(store.get().platform), kind: "viewer", platform })).device;
            break;
          } catch (enrollErr) {
            if (!isNetworkFailure(enrollErr)) throw enrollErr;
          }
        } else if (!isNetworkFailure(err)) {
          throw err;
        }
        store.set({ phase: { kind: "unreachable" } });
        await this.sleep(HEALTH_RETRY_MS);
      }
    }
    for (;;) {
      if (device.revokedAt) {
        store.set({
          phase: {
            kind: "fatal",
            title: "This device was revoked",
            message: "Another device revoked this one's access to the inbox. Clear this browser's site data to enroll it again, then approve it from an approved device.",
          },
        });
        return null;
      }
      if (device.approvedAt && device.wrappedInboxKey) {
        return crypto.unwrapInboxKey(device.wrappedInboxKey, keys);
      }
      store.set({ phase: { kind: "pending-approval" } });
      await this.refreshHubStatus();
      await this.sleep(APPROVAL_POLL_MS);
      try {
        device = (await relay.me()).device;
      } catch (err) {
        if (!isNetworkFailure(err)) throw err;
        store.set({ phase: { kind: "unreachable" } });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => void window.setTimeout(resolve, ms));
  }

  private every(ms: number, fn: () => Promise<void>): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        console.warn("loop failed", err);
      }
      if (!this.stopped) this.timers.push(window.setTimeout(tick, ms));
    };
    this.timers.push(window.setTimeout(tick, 0));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) window.clearTimeout(t);
  }

  // ---- hub status -------------------------------------------------------

  async refreshHubStatus(): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    let reading: HubReading | { kind: "ok"; hub: null };
    try {
      const { hub } = await relay.hubStatus();
      reading = { kind: "ok", hub };
    } catch (err) {
      reading = { kind: "request-failed", error: errText(err) };
    }
    const offline = isHubOffline(reading);
    const prev = store.get();
    const hubRecord: HubStatusRecord = reading.kind === "ok" ? reading.hub : prev.hubRecord;
    let hubStatus = prev.hubStatus;
    let hubStatusError: string | null = null;
    if (reading.kind === "ok" && reading.hub?.statusSealed && this.inboxKey) {
      try {
        const opened = HubStatus(crypto.openBlob(this.inboxKey, reading.hub.statusSealed));
        if (opened instanceof type.errors) hubStatusError = `The hub's status did not validate: ${opened.summary}`;
        else hubStatus = opened;
      } catch (err) {
        hubStatusError = `The hub's status could not be opened: ${errText(err)}`;
      }
    } else if (reading.kind === "request-failed") {
      hubStatusError = reading.error;
    }
    const cameBack = prev.hubOffline && !offline;
    store.set({
      hubRecord,
      hubStatus,
      hubStatusError,
      hubOffline: offline,
      hubOfflineSince: offline ? (prev.hubOfflineSince ?? new Date().toISOString()) : null,
    });
    if (cameBack) void this.syncNow();
  }

  /** button-retry-hub: check the hub and sync right now. */
  async retryHub(): Promise<void> {
    await this.refreshHubStatus();
    await this.syncNow();
  }

  // ---- sync ------------------------------------------------------------

  async syncNow(): Promise<void> {
    const relay = this.relay;
    const cache = this.cache;
    const inboxKey = this.inboxKey;
    if (!relay || !cache || !inboxKey || this.syncing) return;
    this.syncing = true;
    try {
      const known = await cache.knownVersions();
      const { changed, problems } = await pullChanges(relay, inboxKey, (id) => known.get(id));
      await cache.upsertAll(changed);
      const at = new Date().toISOString();
      await cache.setMeta(META_LAST_SYNCED, at);
      await this.reloadRows();
      const prev = store.get();
      const selectedChanged = prev.selectedKey !== null && changed.some((c) => `${c.state.service}:${c.state.conversationId}` === prev.selectedKey);
      if (selectedChanged && prev.selectedKey) store.set({ selectedState: await cache.state(prev.selectedKey) });
      store.set({ lastSyncedAt: at, firstSyncDone: true, lastSyncError: problems.length > 0 ? problems.join("; ") : null });
    } catch (err) {
      store.set({ lastSyncError: errText(err) });
    } finally {
      this.syncing = false;
    }
  }

  private async reloadRows(): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    const rows = await cache.list();
    const { searchText } = store.get();
    const searchResults = searchText.trim() ? await cache.search(searchText) : null;
    store.set({ conversations: rows, searchResults });
  }

  async setSearch(text: string): Promise<void> {
    const cache = this.cache;
    store.set({ searchText: text });
    if (!cache) return;
    if (!text.trim()) {
      store.set({ searchResults: null });
      return;
    }
    const results = await cache.search(text);
    if (store.get().searchText === text) store.set({ searchResults: results });
  }

  // ---- selection and triage -------------------------------------------

  /** Row click: open the thread and mark it read (FR-7, FR-10); never on hover. */
  async openConversation(key: string): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    const row = store.get().conversations.find((r) => r.key === key);
    store.set({ selectedKey: key, selectedState: await cache.state(key) });
    if (row?.unread && !store.get().hubOffline) await this.setUnread([key], false);
  }

  closeConversation(): void {
    store.set({ selectedKey: null, selectedState: null });
  }

  async setUnread(keys: string[], unread: boolean): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    if (store.get().hubOffline) throw new HubOfflineError();
    await cache.setUnread(keys, unread);
    await this.reloadRows();
    const { selectedKey } = store.get();
    if (selectedKey && keys.includes(selectedKey)) store.set({ selectedState: await cache.state(selectedKey) });
    try {
      await this.request({ type: unread ? "triage.markUnread" : "triage.markRead", conversationIds: keys });
    } catch (err) {
      store.set({ actionError: `The hub did not confirm the read-state change: ${errText(err)}` });
    }
  }

  async markAllRead(): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    if (store.get().hubOffline) throw new HubOfflineError();
    await cache.markAllRead();
    store.set({ selectedKey: null, selectedState: null });
    await this.reloadRows();
    try {
      await this.request({ type: "triage.markAllRead" });
    } catch (err) {
      store.set({ actionError: `The hub did not confirm mark all read: ${errText(err)}` });
    }
  }

  // ---- events to and from the hub -------------------------------------

  private hubTarget(): NonNullable<HubStatusRecord> {
    const hub = store.get().hubRecord;
    if (!hub) throw new HubOfflineError();
    return hub;
  }

  /** Seals one event to the hub and returns its id. */
  private async send(body: EventBody): Promise<string> {
    const relay = this.relay;
    const keys = this.keys;
    if (!relay || !keys) throw new Error("The session is not ready");
    const hub = this.hubTarget();
    const event = { ...body, id: newEventId(), at: new Date().toISOString() };
    const checked = HubBoundEvent(event);
    if (checked instanceof type.errors) throw new Error(`Malformed event: ${checked.summary}`);
    const sealed = crypto.sealEnvelope(checked, { from: keys, toPublicKey: hub.publicKey });
    await relay.mailboxSend(hub.deviceId, this.mailDomain, sealed);
    return checked.id;
  }

  /** Sends an event and resolves with the hub's first reply; reply.error rejects. */
  request(body: EventBody, timeoutMs = REPLY_TIMEOUT_MS): Promise<ViewerBoundEvent> {
    return new Promise<ViewerBoundEvent>((resolve, reject) => {
      void this.send(body)
        .then((id) => {
          this.subscribe(
            id,
            (event) => {
              if (event.type === "reply.error") reject(new HubReplyError(event.message));
              else resolve(event);
              return "done";
            },
            () => reject(new HubReplyError("The hub did not reply in time.")),
            timeoutMs,
          );
        })
        .catch(reject);
    });
  }

  /** Sends an event and streams every reply to `onEvent` until it returns "done". */
  async stream(body: EventBody, onEvent: Subscriber, onTimeout: () => void, timeoutMs = REPLY_TIMEOUT_MS): Promise<() => void> {
    const id = await this.send(body);
    this.subscribe(id, onEvent, onTimeout, timeoutMs);
    return () => this.unsubscribe(id);
  }

  private subscribe(id: string, onEvent: Subscriber, onTimeout: () => void, timeoutMs: number): void {
    const timer = window.setTimeout(() => {
      this.pending.delete(id);
      onTimeout();
    }, timeoutMs);
    this.pending.set(id, { onEvent, onTimeout, timer });
  }

  private unsubscribe(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private async pollMailbox(): Promise<void> {
    const relay = this.relay;
    const keys = this.keys;
    if (!relay || !keys) return;
    const messages = await relay.mailboxList();
    if (messages.length === 0) return;
    const hub = store.get().hubRecord;
    for (const m of messages.sort((a, b) => a.uid - b.uid)) {
      try {
        if (!hub) throw new Error("no hub to verify the sender against");
        const env = crypto.openEnvelope<unknown>(m.body, keys, (id) => (id === hub.deviceId ? hub.publicKey : undefined));
        const event = ViewerBoundEvent(env.body);
        if (event instanceof type.errors) throw new Error(`malformed reply: ${event.summary}`);
        const p = this.pending.get(event.inReplyTo);
        if (p) {
          const outcome = p.onEvent(event);
          if (outcome === "done") this.unsubscribe(event.inReplyTo);
          else {
            window.clearTimeout(p.timer);
            p.timer = window.setTimeout(() => {
              this.pending.delete(event.inReplyTo);
              p.onTimeout();
            }, REPLY_TIMEOUT_MS);
          }
        }
      } catch (err) {
        console.warn("dropping unreadable mailbox message", m.uid, errText(err));
      }
      await relay.mailboxTrash(m.uid).catch((err: unknown) => console.warn("trash failed", m.uid, errText(err)));
    }
  }

  // ---- Connections screen ---------------------------------------------

  async refreshDevices(): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    try {
      const { devices } = await relay.devices();
      store.set({ devices, devicesError: null });
    } catch (err) {
      store.set({ devicesError: errText(err) });
    }
  }

  async approveDevice(id: string): Promise<void> {
    const relay = this.relay;
    const inboxKey = this.inboxKey;
    if (!relay || !inboxKey) return;
    const device = store.get().devices.find((d) => d.id === id);
    if (!device) throw new Error(`No device ${id} in the list`);
    await relay.approveDevice(id, crypto.wrapInboxKey(inboxKey, device.publicKey));
    await this.refreshDevices();
  }

  async revokeDevice(id: string): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    await relay.revokeDevice(id);
    await this.refreshDevices();
  }

  /** The hub re-heartbeats within ~2s of a settings change; pick it up. */
  private refreshHubStatusSoon(): void {
    void this.refreshHubStatus();
    window.setTimeout(() => void this.refreshHubStatus(), 2_500);
    window.setTimeout(() => void this.refreshHubStatus(), 6_000);
  }

  async restartHub(): Promise<void> {
    await this.request({ type: "hub.restart" });
    this.refreshHubStatusSoon();
  }

  async setImessagePaused(paused: boolean): Promise<void> {
    await this.request({ type: "imessage.setPaused", paused });
    this.refreshHubStatusSoon();
  }

  async saveSlackApp(clientId: string, clientSecret: string, appToken: string): Promise<void> {
    await this.request({ type: "slack.saveApp", clientId, clientSecret, appToken });
    store.set({ slackNotice: "Slack app settings saved on the Mac hub." });
    this.refreshHubStatusSoon();
  }

  async startSlackConnect(): Promise<void> {
    store.set({ slackConnectBusy: true, slackConnectError: null });
    try {
      const reply = await this.request({ type: "slack.startConnect", redirectUri: slackRedirectUri(window.location.origin) });
      if (reply.type !== "slack.authorizeUrl") throw new HubReplyError(`Unexpected reply ${reply.type}`);
      window.location.assign(reply.url);
    } catch (err) {
      store.set({ slackConnectBusy: false, slackConnectError: errText(err) });
    }
  }

  async finishSlackConnect(code: string, state: string): Promise<void> {
    store.set({ slackConnectBusy: true, slackConnectError: null });
    try {
      const reply = await this.request({ type: "slack.finishConnect", code, state, redirectUri: slackRedirectUri(window.location.origin) });
      if (reply.type !== "slack.connected") throw new HubReplyError(`Unexpected reply ${reply.type}`);
      store.set({ slackNotice: `Connected ${reply.teamName}.`, slackConnectBusy: false });
      this.refreshHubStatusSoon();
    } catch (err) {
      store.set({ slackConnectBusy: false, slackConnectError: errText(err) });
    }
  }

  async removeSlackWorkspace(teamId: string): Promise<void> {
    await this.request({ type: "slack.removeWorkspace", teamId });
    this.refreshHubStatusSoon();
  }

  private cancelWhatsAppLink: (() => void) | null = null;

  /** button-whatsapp-relink: ask the hub for a QR session; frames land in the store. */
  async showWhatsAppQr(): Promise<void> {
    store.set({ whatsappQrShown: true, whatsappQr: null, whatsappError: null });
    try {
      this.cancelWhatsAppLink = await this.stream(
        { type: "whatsapp.link" },
        (event) => {
          if (event.type === "whatsapp.qr") {
            store.set({ whatsappQr: event.qr });
            return "keep";
          }
          if (event.type === "whatsapp.linked") {
            store.set({ whatsappQrShown: false, whatsappQr: null });
            this.refreshHubStatusSoon();
            return "done";
          }
          if (event.type === "reply.error") {
            store.set({ whatsappError: event.message, whatsappQr: null });
            return "done";
          }
          return "keep";
        },
        () => store.set({ whatsappError: "The hub stopped sending QR codes. Press Show QR code to try again.", whatsappQr: null }),
        5 * 60_000,
      );
    } catch (err) {
      store.set({ whatsappError: errText(err), whatsappQr: null });
    }
  }

  hideWhatsAppQr(): void {
    this.cancelWhatsAppLink?.();
    this.cancelWhatsAppLink = null;
    store.set({ whatsappQrShown: false, whatsappQr: null });
  }

  clearActionError(): void {
    store.set({ actionError: null });
  }
}

export const session = new Session();
