import sodium from "libsodium-wrappers-sumo";

/**
 * The end-to-end layer (ADR-2, ADR-8, ADR-9). Three primitives over libsodium:
 *
 * - an inbox key (XSalsa20-Poly1305 secretbox) seals every conversation blob,
 *   wrapped per enrolled device with a sealed box to that device's key;
 * - device-to-device envelopes (triage, credentials, QR frames) are signed by
 *   the sender's Ed25519 key and sealed to the receiver's X25519 key, derived
 *   from the same Ed25519 pair;
 * - every relay request is signed with the device's Ed25519 key, so the relay
 *   authenticates devices without a password or a session.
 *
 * The relay never holds an inbox key, a device private key, or a plaintext.
 */

export type DeviceKeys = {
  /** Ed25519 public key, base64url. Also what the relay stores. */
  publicKey: string;
  /** Ed25519 secret key, base64url. Never leaves the device. */
  secretKey: string;
};

const B64 = () => sodium.base64_variants.URLSAFE_NO_PADDING;

export async function ready(): Promise<void> {
  await sodium.ready;
}

export function toB64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, B64());
}
export function fromB64(s: string): Uint8Array {
  return sodium.from_base64(s, B64());
}
export function utf8(s: string): Uint8Array {
  return sodium.from_string(s);
}
export function fromUtf8(b: Uint8Array): string {
  return sodium.to_string(b);
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  await sodium.ready;
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: toB64(kp.publicKey), secretKey: toB64(kp.privateKey) };
}

/**
 * A device's id is derived from its public key, so it cannot be chosen. Lower
 * case hex because the id doubles as the local part of a mail address on the
 * relay, and address handling is case-insensitive.
 */
export function deviceIdFor(publicKeyB64: string): string {
  const h = sodium.crypto_generichash(12, fromB64(publicKeyB64), null);
  return `dev_${sodium.to_hex(h)}`;
}

export async function generateInboxKey(): Promise<string> {
  await sodium.ready;
  return toB64(sodium.crypto_secretbox_keygen());
}

const BLOB_PREFIX = "ib1.";

/** Seal a JSON value under the inbox key. Output is an opaque string. */
export function sealBlob(inboxKeyB64: string, value: unknown): string {
  const key = fromB64(inboxKeyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(utf8(JSON.stringify(value)), nonce, key);
  return `${BLOB_PREFIX}${toB64(nonce)}.${toB64(ct)}`;
}

export class SealError extends Error {}

export function openBlob<T = unknown>(inboxKeyB64: string, blob: string): T {
  if (!blob.startsWith(BLOB_PREFIX)) throw new SealError("not an inbox blob");
  const [nonceB64, ctB64] = blob.slice(BLOB_PREFIX.length).split(".");
  if (!nonceB64 || !ctB64) throw new SealError("malformed inbox blob");
  const key = fromB64(inboxKeyB64);
  let pt: Uint8Array;
  try {
    pt = sodium.crypto_secretbox_open_easy(fromB64(ctB64), fromB64(nonceB64), key);
  } catch {
    throw new SealError("inbox blob did not open: wrong key or tampered");
  }
  return JSON.parse(fromUtf8(pt)) as T;
}

function curvePk(signPkB64: string): Uint8Array {
  return sodium.crypto_sign_ed25519_pk_to_curve25519(fromB64(signPkB64));
}
function curveSk(signSkB64: string): Uint8Array {
  return sodium.crypto_sign_ed25519_sk_to_curve25519(fromB64(signSkB64));
}

/** Wrap the inbox key for one device: only that device's secret key opens it. */
export function wrapInboxKey(inboxKeyB64: string, recipientPublicKeyB64: string): string {
  return toB64(sodium.crypto_box_seal(fromB64(inboxKeyB64), curvePk(recipientPublicKeyB64)));
}

export function unwrapInboxKey(wrappedB64: string, keys: DeviceKeys): string {
  try {
    const key = sodium.crypto_box_seal_open(fromB64(wrappedB64), curvePk(keys.publicKey), curveSk(keys.secretKey));
    return toB64(key);
  } catch {
    throw new SealError("wrapped inbox key did not open for this device");
  }
}

export type Envelope<T> = {
  v: 1;
  from: string;
  to: string;
  at: string;
  body: T;
};

/**
 * Seal a device-to-device message: signed by the sender, readable only by the
 * receiver. The relay carries the result as mailbox text it cannot open.
 */
export function sealEnvelope<T>(body: T, opts: { from: DeviceKeys; toPublicKey: string }): string {
  const fromId = deviceIdFor(opts.from.publicKey);
  const env: Envelope<T> = { v: 1, from: fromId, to: deviceIdFor(opts.toPublicKey), at: new Date().toISOString(), body };
  const payload = utf8(JSON.stringify(env));
  const sig = sodium.crypto_sign_detached(payload, fromB64(opts.from.secretKey));
  const outer = JSON.stringify({ p: toB64(payload), s: toB64(sig), k: opts.from.publicKey });
  return toB64(sodium.crypto_box_seal(utf8(outer), curvePk(opts.toPublicKey)));
}

/**
 * Open a device-to-device message. `trustedSenderKey` returns the public key
 * the relay has on record for a device id; the envelope is accepted only when
 * the embedded key matches it and the signature verifies.
 */
export function openEnvelope<T>(
  sealed: string,
  me: DeviceKeys,
  trustedSenderKey: (deviceId: string) => string | undefined,
): Envelope<T> {
  let outerBytes: Uint8Array;
  try {
    outerBytes = sodium.crypto_box_seal_open(fromB64(sealed), curvePk(me.publicKey), curveSk(me.secretKey));
  } catch {
    throw new SealError("envelope did not open for this device");
  }
  const outer = JSON.parse(fromUtf8(outerBytes)) as { p: string; s: string; k: string };
  const payload = fromB64(outer.p);
  const env = JSON.parse(fromUtf8(payload)) as Envelope<T>;
  const expected = trustedSenderKey(env.from);
  if (!expected || expected !== outer.k) throw new SealError(`envelope from unknown or mismatched device ${env.from}`);
  if (!sodium.crypto_sign_verify_detached(fromB64(outer.s), payload, fromB64(outer.k))) {
    throw new SealError("envelope signature did not verify");
  }
  if (env.to !== deviceIdFor(me.publicKey)) throw new SealError("envelope addressed to another device");
  return env;
}

/** Hex SHA-256 of a request body, for request signing. */
export function sha256Hex(bytes: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_hash_sha256(bytes));
}

export function canonicalRequest(method: string, pathWithQuery: string, timestamp: string, bodySha256Hex: string): Uint8Array {
  return utf8(`${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodySha256Hex}`);
}

/** `Authorization: Device <id>:<unix-ms>:<sig>` */
export function signRequest(keys: DeviceKeys, method: string, pathWithQuery: string, body: Uint8Array | null, now = Date.now()): string {
  const ts = String(now);
  const bodyHash = sha256Hex(body ?? new Uint8Array());
  const sig = sodium.crypto_sign_detached(canonicalRequest(method, pathWithQuery, ts, bodyHash), fromB64(keys.secretKey));
  return `Device ${deviceIdFor(keys.publicKey)}:${ts}:${toB64(sig)}`;
}

export const REQUEST_SKEW_MS = 5 * 60 * 1000;

export type VerifiedRequest = { deviceId: string; timestamp: number };

export function parseAuthorization(header: string | null | undefined): { deviceId: string; ts: string; sig: string } | null {
  if (!header || !header.startsWith("Device ")) return null;
  const parts = header.slice("Device ".length).split(":");
  if (parts.length !== 3) return null;
  const [deviceId, ts, sig] = parts as [string, string, string];
  return { deviceId, ts, sig };
}

export function verifyRequest(
  parsed: { deviceId: string; ts: string; sig: string },
  publicKeyB64: string,
  method: string,
  pathWithQuery: string,
  body: Uint8Array | null,
  now = Date.now(),
): VerifiedRequest | null {
  if (deviceIdFor(publicKeyB64) !== parsed.deviceId) return null;
  const ts = Number(parsed.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REQUEST_SKEW_MS) return null;
  const msg = canonicalRequest(method, pathWithQuery, parsed.ts, sha256Hex(body ?? new Uint8Array()));
  try {
    if (!sodium.crypto_sign_verify_detached(fromB64(parsed.sig), msg, fromB64(publicKeyB64))) return null;
  } catch {
    return null;
  }
  return { deviceId: parsed.deviceId, timestamp: ts };
}

export function randomToken(bytes = 24): string {
  return toB64(sodium.randombytes_buf(bytes));
}
