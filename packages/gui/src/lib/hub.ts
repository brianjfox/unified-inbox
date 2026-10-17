import type { HubStatusRecord } from "@inbox/shared/relay-client";

/** A heartbeat older than this means the hub is gone (the hub beats every 30s). */
export const HUB_STALE_MS = 90_000;

export type HubReading =
  | { kind: "ok"; hub: NonNullable<HubStatusRecord> }
  | { kind: "request-failed"; error: string };

/**
 * The offline decision (FR-16): the hub is OFFLINE when the relay request
 * failed, when no approved hub is enrolled, when it has never sent a
 * heartbeat, or when its last heartbeat is older than 90 seconds.
 */
export function isHubOffline(reading: HubReading | { kind: "ok"; hub: null }, now: number = Date.now()): boolean {
  if (reading.kind === "request-failed") return true;
  const hub = reading.hub;
  if (!hub || !hub.lastHeartbeatAt) return true;
  const beat = Date.parse(hub.lastHeartbeatAt);
  if (!Number.isFinite(beat)) return true;
  return now - beat > HUB_STALE_MS;
}
