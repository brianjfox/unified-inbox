import { signRequest, utf8, ready as sodiumReady, type DeviceKeys } from "./crypto.ts";
import type { DeviceRecord, DeviceKind } from "./schema.ts";
import { PROTOCOL_SUBJECT } from "./protocol.ts";
import { base64ToBytes, bodyOfFrame, headerOfFrame } from "./mail.ts";

export type ArtifactListItem = {
  id: string;
  kind: string;
  title: string;
  version: number;
  updatedAt: string;
  createdAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown> | null;
};
export type ArtifactDetail = ArtifactListItem & { content: string };

export type MailboxMessage = {
  uid: number;
  flags: string[];
  envelope: { messageId: string; from: string; to: string[]; subject: string; date: string };
  /** The protocol payload (sealed envelope), extracted from the frame body. */
  body: string;
  fromPrincipalId: string;
};

export type HubStatusRecord = {
  deviceId: string;
  publicKey: string;
  label: string;
  lastHeartbeatAt: string | null;
  statusSealed: string | null;
} | null;

export class RelayError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The subset of fetch the client needs; Bun, Node and browsers all satisfy it. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<Response>;

export type RelayClientOptions = {
  baseUrl: string;
  tenantId?: string;
  keys?: DeviceKeys;
  fetch?: FetchLike;
};

/**
 * The one HTTP client every component uses to talk to the relay. Requests are
 * signed with the device key (crypto.ts); nothing here ever sees a plaintext
 * message, only sealed blobs it passes through.
 */
export class RelayClient {
  readonly baseUrl: string;
  readonly tenantId: string;
  private keys: DeviceKeys | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.tenantId = opts.tenantId ?? "inbox";
    this.keys = opts.keys;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  setKeys(keys: DeviceKeys): void {
    this.keys = keys;
  }

  get tenantPath(): string {
    return `/api/tenants/${this.tenantId}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts: { signed?: boolean } = {}): Promise<T> {
    await sodiumReady();
    const signed = opts.signed ?? true;
    const bodyBytes = body === undefined ? null : utf8(JSON.stringify(body));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bodyBytes) headers["Content-Type"] = "application/json";
    if (signed) {
      if (!this.keys) throw new RelayError(0, "no_keys", "This device has no keys yet");
      headers.Authorization = signRequest(this.keys, method, path, bodyBytes);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(bodyBytes ? { body: bodyBytes } : {}) });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; code?: string };
      throw new RelayError(res.status, err.code, `${method} ${path} → ${res.status}: ${err.error ?? text}`);
    }
    return json as T;
  }

  health(): Promise<{ ok: boolean; tenant: string; mailDomain: string; publicOrigin: string }> {
    return this.request("GET", "/api/health", undefined, { signed: false });
  }

  enroll(input: { publicKey: string; label: string; kind: DeviceKind; platform?: string }): Promise<{ device: DeviceRecord }> {
    return this.request("POST", "/api/enroll", input, { signed: false });
  }

  me(): Promise<{ device: DeviceRecord }> {
    return this.request("GET", `${this.tenantPath}/me`);
  }

  devices(): Promise<{ devices: DeviceRecord[] }> {
    return this.request("GET", `${this.tenantPath}/devices`);
  }

  approveDevice(id: string, wrappedInboxKey?: string): Promise<{ device: DeviceRecord }> {
    return this.request("POST", `${this.tenantPath}/devices/${encodeURIComponent(id)}/approve`, wrappedInboxKey ? { wrappedInboxKey } : {});
  }

  revokeDevice(id: string): Promise<{ device: DeviceRecord }> {
    return this.request("POST", `${this.tenantPath}/devices/${encodeURIComponent(id)}/revoke`, {});
  }

  heartbeat(statusSealed: string): Promise<{ ok: boolean; at: string }> {
    return this.request("POST", `${this.tenantPath}/hub/heartbeat`, { statusSealed });
  }

  hubStatus(): Promise<{ hub: HubStatusRecord }> {
    return this.request("GET", `${this.tenantPath}/hub/status`);
  }

  createConversation(title: string, content: string): Promise<{ artifact: ArtifactDetail }> {
    return this.request("POST", `${this.tenantPath}/conversations`, { title, content });
  }

  listArtifacts(opts: { kind?: string; limit?: number; cursor?: string | null } = {}): Promise<{ artifacts: ArtifactListItem[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    if (opts.kind) q.set("kind", opts.kind);
    q.set("limit", String(opts.limit ?? 100));
    if (opts.cursor) q.set("cursor", opts.cursor);
    return this.request("GET", `${this.tenantPath}/artifacts?${q.toString()}`);
  }

  getArtifact(id: string): Promise<{ artifact: ArtifactDetail }> {
    return this.request("GET", `${this.tenantPath}/artifacts/${encodeURIComponent(id)}`);
  }

  reviseArtifact(id: string, content: string, expectedVersion?: number): Promise<{ artifactId: string; version: number }> {
    return this.request("POST", `${this.tenantPath}/artifacts/${encodeURIComponent(id)}/versions`, {
      content,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  }

  /** Lists protocol messages in a folder, newest first, with their payloads extracted. */
  async mailboxList(opts: { folder?: string; limit?: number } = {}): Promise<MailboxMessage[]> {
    const q = new URLSearchParams();
    q.set("folder", opts.folder ?? "INBOX");
    q.set("limit", String(opts.limit ?? 200));
    const res = await this.request<{ messages: Array<{ uid: number; flags: string[]; envelope: MailboxMessage["envelope"]; raw: string }> }>(
      "GET",
      `${this.tenantPath}/mailbox/me/inbox?${q.toString()}`,
    );
    const out: MailboxMessage[] = [];
    for (const m of res.messages) {
      const raw = base64ToBytes(m.raw);
      const subject = headerOfFrame(raw, "Subject") ?? m.envelope.subject;
      if (subject !== PROTOCOL_SUBJECT) continue;
      const from = m.envelope.from;
      const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
      out.push({ uid: m.uid, flags: m.flags, envelope: m.envelope, body: bodyOfFrame(raw), fromPrincipalId: addr.split("@")[0]!.replace(/^usr_/, "") });
    }
    return out;
  }

  mailboxSend(toPrincipalId: string, domain: string, sealedBody: string): Promise<{ messageId: string; uid: number }> {
    return this.request("POST", `${this.tenantPath}/mailbox/me/inbox/send`, {
      to: [`${toPrincipalId}@${domain}`],
      subject: PROTOCOL_SUBJECT,
      body: sealedBody,
    });
  }

  mailboxTrash(uid: number, folder = "INBOX"): Promise<unknown> {
    return this.request("POST", `${this.tenantPath}/mailbox/me/inbox/${uid}/trash?folder=${encodeURIComponent(folder)}`, {});
  }

  /** Purges this device's whole mailbox (Sent, Trash) once its INBOX is empty. */
  mailboxPurge(): Promise<{ purged: number; skipped?: string }> {
    return this.request("POST", `${this.tenantPath}/mailbox/me/purge`, {});
  }

  mailboxMarkRead(uid: number, folder = "INBOX"): Promise<unknown> {
    return this.request("POST", `${this.tenantPath}/mailbox/me/inbox/${uid}/read?folder=${encodeURIComponent(folder)}`, {});
  }
}
