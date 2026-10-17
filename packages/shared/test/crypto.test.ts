import { describe, test, expect, beforeAll } from "bun:test";
import * as c from "../src/crypto.ts";

beforeAll(() => c.ready());

describe("crypto layer", () => {
  test("inbox blobs open only with the inbox key", async () => {
    const key = await c.generateInboxKey();
    const other = await c.generateInboxKey();
    const blob = c.sealBlob(key, { hello: "world", n: 1 });
    expect(blob.startsWith("ib1.")).toBe(true);
    expect(blob).not.toContain("hello");
    expect(c.openBlob(key, blob)).toEqual({ hello: "world", n: 1 });
    expect(() => c.openBlob(other, blob)).toThrow(c.SealError);
    expect(() => c.openBlob(key, blob.slice(0, -2) + "zz")).toThrow(c.SealError);
    expect(() => c.openBlob(key, "nope")).toThrow(c.SealError);
  });

  test("device ids are derived, lowercase, and mail-safe", async () => {
    const k = await c.generateDeviceKeys();
    const id = c.deviceIdFor(k.publicKey);
    expect(id).toMatch(/^dev_[0-9a-f]{24}$/);
    expect(c.deviceIdFor(k.publicKey)).toBe(id);
  });

  test("inbox key wraps per device", async () => {
    const key = await c.generateInboxKey();
    const a = await c.generateDeviceKeys();
    const b = await c.generateDeviceKeys();
    const wrapped = c.wrapInboxKey(key, a.publicKey);
    expect(c.unwrapInboxKey(wrapped, a)).toBe(key);
    expect(() => c.unwrapInboxKey(wrapped, b)).toThrow(c.SealError);
  });

  test("envelopes are signed by the sender and readable only by the receiver", async () => {
    const a = await c.generateDeviceKeys();
    const b = await c.generateDeviceKeys();
    const eve = await c.generateDeviceKeys();
    const sealed = c.sealEnvelope({ type: "triage.markRead", ids: ["x"] }, { from: a, toPublicKey: b.publicKey });
    expect(sealed).not.toContain("markRead");
    const trusted = (id: string) => (id === c.deviceIdFor(a.publicKey) ? a.publicKey : undefined);
    const env = c.openEnvelope<{ type: string }>(sealed, b, trusted);
    expect(env.body.type).toBe("triage.markRead");
    expect(env.from).toBe(c.deviceIdFor(a.publicKey));
    expect(env.to).toBe(c.deviceIdFor(b.publicKey));
    expect(() => c.openEnvelope(sealed, eve, trusted)).toThrow(c.SealError);
    // Receiver refuses a sender it does not trust, and a sender whose key changed.
    expect(() => c.openEnvelope(sealed, b, () => undefined)).toThrow(c.SealError);
    expect(() => c.openEnvelope(sealed, b, () => eve.publicKey)).toThrow(c.SealError);
  });

  test("request signatures bind method, path, body and time", async () => {
    const k = await c.generateDeviceKeys();
    const body = c.utf8(JSON.stringify({ a: 1 }));
    const now = Date.now();
    const header = c.signRequest(k, "POST", "/api/x?y=1", body, now);
    const parsed = c.parseAuthorization(header)!;
    expect(parsed.deviceId).toBe(c.deviceIdFor(k.publicKey));
    expect(c.verifyRequest(parsed, k.publicKey, "POST", "/api/x?y=1", body, now)).toMatchObject({ deviceId: parsed.deviceId });
    expect(c.verifyRequest(parsed, k.publicKey, "GET", "/api/x?y=1", body, now)).toBeNull();
    expect(c.verifyRequest(parsed, k.publicKey, "POST", "/api/x", body, now)).toBeNull();
    expect(c.verifyRequest(parsed, k.publicKey, "POST", "/api/x?y=1", c.utf8("{}"), now)).toBeNull();
    expect(c.verifyRequest(parsed, k.publicKey, "POST", "/api/x?y=1", body, now + c.REQUEST_SKEW_MS + 1000)).toBeNull();
    const other = await c.generateDeviceKeys();
    expect(c.verifyRequest(parsed, other.publicKey, "POST", "/api/x?y=1", body, now)).toBeNull();
    expect(c.parseAuthorization("Bearer abc")).toBeNull();
  });
});
