import { useSyncExternalStore } from "react";
import type { ConversationState, DeviceRecord, HubStatus } from "@inbox/shared/schema";
import type { HubStatusRecord } from "@inbox/shared/relay-client";
import type { Platform } from "@inbox/shared/deeplink";
import type { ConversationRow } from "../db/cache.ts";

export type Phase =
  /** Keys, health and the local cache are being set up. */
  | { kind: "booting" }
  /** GET /api/health failed; retrying. */
  | { kind: "unreachable" }
  /** Enrolled, waiting for another device (or the hub, for the first viewer) to approve. */
  | { kind: "pending-approval" }
  | { kind: "ready" }
  /** Something named is missing and the app cannot run; shown in full. */
  | { kind: "fatal"; title: string; message: string };

export type AppState = {
  phase: Phase;
  deviceId: string | null;
  platform: Platform;
  mailDomain: string | null;
  hubRecord: HubStatusRecord;
  hubStatus: HubStatus | null;
  /** The sealed status could not be opened or validated. */
  hubStatusError: string | null;
  hubOffline: boolean;
  /** When this viewer first noticed the hub was unreachable. */
  hubOfflineSince: string | null;
  lastSyncedAt: string | null;
  /** True once the list reflects a completed sync or a non-empty cache. */
  firstSyncDone: boolean;
  lastSyncError: string | null;
  conversations: ConversationRow[];
  selectedKey: string | null;
  selectedState: ConversationState | null;
  searchText: string;
  searchResults: ConversationRow[] | null;
  devices: DeviceRecord[];
  devicesError: string | null;
  slackConnectError: string | null;
  slackConnectBusy: boolean;
  slackNotice: string | null;
  whatsappQr: string | null;
  whatsappQrShown: boolean;
  whatsappError: string | null;
  /** The last triage or Connections action that failed, for the person to see. */
  actionError: string | null;
};

export const initialState: AppState = {
  phase: { kind: "booting" },
  deviceId: null,
  platform: "unknown",
  mailDomain: null,
  hubRecord: null,
  hubStatus: null,
  hubStatusError: null,
  hubOffline: false,
  hubOfflineSince: null,
  lastSyncedAt: null,
  firstSyncDone: false,
  lastSyncError: null,
  conversations: [],
  selectedKey: null,
  selectedState: null,
  searchText: "",
  searchResults: null,
  devices: [],
  devicesError: null,
  slackConnectError: null,
  slackConnectBusy: false,
  slackNotice: null,
  whatsappQr: null,
  whatsappQrShown: false,
  whatsappError: null,
  actionError: null,
};

/** One store for the whole app; components read it with useAppState(). */
export class Store {
  private state: AppState = initialState;
  private readonly listeners = new Set<() => void>();

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState> | ((prev: AppState) => Partial<AppState>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export const store = new Store();

export function useAppState(): AppState {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
}
