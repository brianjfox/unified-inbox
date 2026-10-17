import * as crypto from "@inbox/shared/crypto";
import { RelayError } from "@inbox/shared/relay-client";
import { HubBoundEvent, type ViewerBoundEvent, type ViewerReply, conversationArtifactTitle, newEventId } from "@inbox/shared/protocol";
import { type } from "arktype";
import type { DeviceRecord, HubStatus } from "@inbox/shared/schema";
import type { HubIdentity } from "./identity.ts";
import type { HubStore } from "./store.ts";
import type { Logger } from "./connectors/types.ts";

/**
 * The sync client (task 8): uploads dirty conversations as sealed artifact
 * versions, sends the heartbeat, and polls the hub's mailbox for sealed
 * viewer events, handing each to a dispatcher. The hub is the sole writer of
 * artifacts (FR-9, ADR-5).
 */
export type ReplyFn = (e: ViewerReply) => Promise<void>;
export type EventDispatcher = (event: HubBoundEvent, from: DeviceRecord, reply: ReplyFn) => Promise<void>;

export class SyncClient {
  private devices = new Map<string, DeviceRecord>();
  private devicesRefreshedAt = 0;
  private domain: string;
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  private readonly identity: HubIdentity;
  private readonly store: HubStore;
  private readonly log: Logger;

  constructor(identity: HubIdentity, store: HubStore, log: Logger, opts: { mailDomain: string }) {
    this.identity = identity;
    this.store = store;
    this.log = log;
    this.domain = opts.mailDomain;
  }

  async refreshDevices(force = false): Promise<Map<string, DeviceRecord>> {
    if (!force && Date.now() - this.devicesRefreshedAt < 10_000) return this.devices;
    const { devices } = await this.identity.relay.devices();
    this.devices = new Map(devices.map((d) => [d.id, d]));
    this.devicesRefreshedAt = Date.now();
    return this.devices;
  }

  /** Uploads every dirty conversation. Safe to call often; a no-op when clean. */
  async flush(): Promise<number> {
    const dirty = this.store.dirtyConversations();
    let n = 0;
    for (const { row, state } of dirty) {
      const sealed = crypto.sealBlob(this.identity.inboxKey, state);
      try {
        if (!row.artifact_id) {
          const { artifact } = await this.identity.relay.createConversation(conversationArtifactTitle(state.service, state.conversationId), sealed);
          this.store.markUploaded(row.key, artifact.id, artifact.version);
        } else {
          const res = await this.identity.relay.reviseArtifact(row.artifact_id, sealed);
          this.store.markUploaded(row.key, row.artifact_id, res.version);
        }
        this.store.clearDirtyIfUnchanged(row.key, row.updated_at);
        n++;
      } catch (err) {
        this.log.error("upload failed; will retry", { key: row.key, error: String(err) });
        if (err instanceof RelayError && err.status === 404 && row.artifact_id) {
          // The artifact vanished on the relay (reprovisioned?): create it again.
          this.store.markUploaded(row.key, "", 0);
          this.store.db.prepare("UPDATE conversation SET artifact_id = NULL WHERE key = ?").run(row.key);
        }
        break;
      }
    }
    return n;
  }

  async heartbeat(status: HubStatus): Promise<void> {
    await this.identity.relay.heartbeat(crypto.sealBlob(this.identity.inboxKey, status));
  }

  async sendToViewer(viewer: DeviceRecord, event: ViewerBoundEvent): Promise<void> {
    const sealed = crypto.sealEnvelope(event, { from: this.identity.keys, toPublicKey: viewer.publicKey });
    await this.identity.relay.mailboxSend(viewer.principalId, this.domain, sealed);
  }

  private polls = 0;

  /** One mailbox pass: open every sealed event, dispatch it, trash it. */
  async pollMailbox(dispatch: EventDispatcher): Promise<number> {
    const messages = await this.identity.relay.mailboxList();
    if (messages.length === 0) {
      // Every ~5 minutes of quiet, purge Sent and Trash so the mailbox stays small.
      if (++this.polls % 100 === 0) await this.identity.relay.mailboxPurge().catch(() => undefined);
      return 0;
    }
    const devices = await this.refreshDevices(true);
    let handled = 0;
    for (const m of messages.sort((a, b) => a.uid - b.uid)) {
      try {
        const env = crypto.openEnvelope<unknown>(m.body, this.identity.keys, (id) => {
          const d = devices.get(id);
          return d && d.approvedAt && !d.revokedAt ? d.publicKey : undefined;
        });
        const from = devices.get(env.from);
        if (!from) throw new Error(`event from unknown device ${env.from}`);
        const parsed = HubBoundEvent(env.body);
        if (parsed instanceof type.errors) {
          this.log.warn("ignoring malformed event", { from: env.from, summary: parsed.summary });
        } else if (this.store.hasProcessedEvent(parsed.id)) {
          this.log.debug("skipping duplicate event", { id: parsed.id });
        } else {
          const reply: ReplyFn = async (e) => {
            const full = { ...e, id: newEventId(), at: new Date().toISOString(), inReplyTo: parsed.id } as ViewerBoundEvent;
            await this.sendToViewer(from, full);
          };
          try {
            await dispatch(parsed, from, reply);
          } catch (err) {
            this.log.error("event failed", { type: parsed.type, error: String(err) });
            await reply({ type: "reply.error", message: err instanceof Error ? err.message : String(err) });
          }
          this.store.rememberEvent(parsed.id);
          handled++;
        }
      } catch (err) {
        this.log.warn("dropping unreadable mailbox message", { uid: m.uid, error: String(err) });
      }
      await this.identity.relay.mailboxTrash(m.uid).catch((err) => this.log.warn("trash failed", { uid: m.uid, error: String(err) }));
    }
    return handled;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Runs `fn` every `ms`, never overlapping, until stopped. Errors are logged. */
  every(ms: number, name: string, fn: () => Promise<void>): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.log.error(`${name} failed`, { error: err instanceof Error ? err.message : String(err) });
      }
      if (!this.stopped) this.timers.push(setTimeout(tick, ms));
    };
    this.timers.push(setTimeout(tick, 0));
  }
}
