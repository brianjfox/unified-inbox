import * as crypto from "@inbox/shared/crypto";
import { RelayClient, RelayError } from "@inbox/shared/relay-client";
import type { DeviceRecord } from "@inbox/shared/schema";
import type { Keychain } from "./keychain.ts";
import type { HubConfig } from "./config.ts";
import type { Logger } from "./connectors/types.ts";

export const KEY_DEVICE_SECRET = "device-secret-key";
export const KEY_DEVICE_PUBLIC = "device-public-key";
export const KEY_INBOX = "inbox-key";

export type HubIdentity = {
  keys: crypto.DeviceKeys;
  deviceId: string;
  inboxKey: string;
  relay: RelayClient;
  device: DeviceRecord;
};

export class EnrollmentPendingError extends Error {}

/**
 * The hub's own identity: a device keypair and the inbox key, both minted on
 * first run and kept in the keychain. Enrolls with the relay; the first hub
 * is approved by the relay itself. A second hub waits for approval from a
 * viewer and says so.
 */
export async function establishIdentity(config: HubConfig, keychain: Keychain, log: Logger): Promise<HubIdentity> {
  await crypto.ready();
  let pub = await keychain.get(KEY_DEVICE_PUBLIC);
  let sec = await keychain.get(KEY_DEVICE_SECRET);
  if (!pub || !sec) {
    const generated = await crypto.generateDeviceKeys();
    await keychain.set(KEY_DEVICE_SECRET, generated.secretKey);
    await keychain.set(KEY_DEVICE_PUBLIC, generated.publicKey);
    pub = generated.publicKey;
    sec = generated.secretKey;
    log.info("minted a new device key for this hub");
  }
  const keys: crypto.DeviceKeys = { publicKey: pub, secretKey: sec };
  let inboxKey = await keychain.get(KEY_INBOX);
  if (!inboxKey) {
    inboxKey = await crypto.generateInboxKey();
    await keychain.set(KEY_INBOX, inboxKey);
    log.info("minted the inbox key; it lives only in this Mac's keychain");
  }
  const relay = new RelayClient({ baseUrl: config.relayUrl, tenantId: config.tenantId, keys });
  const deviceId = crypto.deviceIdFor(keys.publicKey);

  let device: DeviceRecord;
  try {
    device = (await relay.me()).device;
  } catch (err) {
    if (!(err instanceof RelayError) || err.status !== 401) throw err;
    device = (await relay.enroll({ publicKey: keys.publicKey, label: config.hubLabel, kind: "hub", platform: "macos" })).device;
    log.info("enrolled this hub with the relay", { deviceId, approved: device.approvedAt !== null });
  }
  if (!device.approvedAt) {
    throw new EnrollmentPendingError(
      `This hub (${deviceId}) is enrolled but not approved. Another hub is already approved for this relay; approve this one from the Connections screen of an approved viewer, or revoke the old hub.`,
    );
  }
  if (device.revokedAt) throw new EnrollmentPendingError(`This hub (${deviceId}) was revoked on the relay.`);
  return { keys, deviceId, inboxKey, relay, device };
}

/**
 * Bootstrap (QUESTIONS.md, item 1): when no approved viewer exists yet, the hub
 * approves the first pending viewer and wraps the inbox key for it. After
 * that, viewers approve each other from the Connections screen.
 */
export async function approveFirstViewerIfNeeded(identity: HubIdentity, log: Logger): Promise<void> {
  const { devices } = await identity.relay.devices();
  const approvedViewers = devices.filter((d) => d.kind === "viewer" && d.approvedAt && !d.revokedAt);
  if (approvedViewers.length > 0) return;
  const pending = devices.filter((d) => d.kind === "viewer" && !d.approvedAt && !d.revokedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = pending[0];
  if (!first) return;
  await identity.relay.approveDevice(first.id, crypto.wrapInboxKey(identity.inboxKey, first.publicKey));
  log.info("approved the first viewer (bootstrap)", { deviceId: first.id, label: first.label });
}
