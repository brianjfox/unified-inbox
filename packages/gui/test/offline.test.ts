import { describe, expect, test } from "bun:test";
import { HUB_STALE_MS, isHubOffline } from "../src/lib/hub.ts";

const now = Date.parse("2026-10-16T12:42:00.000Z");
const hub = (lastHeartbeatAt: string | null) => ({ kind: "ok" as const, hub: { deviceId: "dev_hub", publicKey: "pk", label: "Studio Mac mini", lastHeartbeatAt, statusSealed: "ib1.x.y" } });

describe("isHubOffline (the 90-second rule)", () => {
  test("online when the heartbeat is fresh", () => {
    expect(isHubOffline(hub(new Date(now - 30_000).toISOString()), now)).toBe(false);
  });
  test("online at exactly 90 seconds, offline one millisecond later", () => {
    expect(HUB_STALE_MS).toBe(90_000);
    expect(isHubOffline(hub(new Date(now - 90_000).toISOString()), now)).toBe(false);
    expect(isHubOffline(hub(new Date(now - 90_001).toISOString()), now)).toBe(true);
  });
  test("offline when no hub is enrolled", () => {
    expect(isHubOffline({ kind: "ok", hub: null }, now)).toBe(true);
  });
  test("offline when the hub never sent a heartbeat", () => {
    expect(isHubOffline(hub(null), now)).toBe(true);
  });
  test("offline when the relay request failed", () => {
    expect(isHubOffline({ kind: "request-failed", error: "Failed to fetch" }, now)).toBe(true);
  });
  test("offline when the heartbeat time is unparseable", () => {
    expect(isHubOffline(hub("not a date"), now)).toBe(true);
  });
});
