import type { ConversationState, InboxEvent, Service } from "@inbox/shared/schema";
import { previewFor } from "@inbox/shared/schema";
import { appendMessage, conversationKey, type HubStore } from "./store.ts";
import type { Connector, Logger } from "./connectors/types.ts";
import { ReadBackUnavailableError } from "./connectors/types.ts";

/**
 * The normalizer and triage consumer (tasks 8 and 11). Connectors hand in
 * InboxEvents; this folds them into ConversationState rows the sync client
 * uploads. Read state is applied here and written back to exactly one
 * connector (ADR-5).
 */
export class Normalizer {
  private readonly store: HubStore;
  private readonly connectors: Map<Service, Connector>;
  private readonly log: Logger;
  private readonly onChange: () => void;

  constructor(store: HubStore, connectors: Map<Service, Connector>, log: Logger, onChange: () => void) {
    this.store = store;
    this.connectors = connectors;
    this.log = log;
    this.onChange = onChange;
  }

  ingest(event: InboxEvent): void {
    const key = conversationKey(event.service, event.conversationId);
    if (this.store.hasSeenMessage(key, event.messageId)) return;
    const existing = this.store.getConversation(event.service, event.conversationId);
    const state: ConversationState = existing?.state ?? {
      v: 1,
      service: event.service,
      conversationId: event.conversationId,
      name: event.conversationName,
      isGroup: event.isGroup,
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      ...(event.workspaceName ? { workspaceName: event.workspaceName } : {}),
      messages: [],
      lastMessageAt: event.sentAt,
      preview: "",
      unread: false,
      unreadCount: 0,
      link: event.link,
    };
    if (event.conversationName && event.conversationName !== state.name) state.name = event.conversationName;
    if (event.workspaceName) state.workspaceName = event.workspaceName;
    state.link = { ...state.link, ...event.link };
    const added = appendMessage(state, {
      id: event.messageId,
      senderName: event.senderName,
      senderIsMe: event.senderIsMe,
      body: event.body,
      sentAt: event.sentAt,
    });
    if (!added) {
      this.store.rememberMessage(key, event.messageId);
      return;
    }
    const isNewest = state.messages[state.messages.length - 1]?.id === event.messageId;
    if (!event.senderIsMe && isNewest && (!state.readAt || event.sentAt > state.readAt)) {
      state.unread = true;
      state.unreadCount += 1;
    } else if (event.senderIsMe && isNewest) {
      // Replying from the source app clears unread there; mirror it.
      state.unread = false;
      state.unreadCount = 0;
      state.readAt = event.sentAt;
    }
    state.preview = previewFor(state);
    this.store.putConversation(state);
    this.store.rememberMessage(key, event.messageId);
    this.onChange();
  }

  rename(service: Service, conversationId: string, name: string): void {
    const existing = this.store.getConversation(service, conversationId);
    if (!existing || existing.state.name === name) return;
    existing.state.name = name;
    this.store.putConversation(existing.state);
    this.onChange();
  }

  /** Marks conversations read locally and in the source service. */
  async markRead(keys: string[]): Promise<void> {
    for (const key of keys) {
      const [service, ...rest] = key.split(":") as [Service, ...string[]];
      const conversationId = rest.join(":");
      const existing = this.store.getConversation(service, conversationId);
      if (!existing) continue;
      const state = existing.state;
      const wasUnread = state.unread;
      state.unread = false;
      state.unreadCount = 0;
      state.readAt = new Date().toISOString();
      this.store.putConversation(state);
      if (wasUnread) {
        const connector = this.connectors.get(service);
        if (connector) {
          try {
            await connector.markRead(conversationId);
          } catch (err) {
            if (err instanceof ReadBackUnavailableError) this.log.debug("read-back unavailable", { service, conversationId });
            else this.log.warn("read-back failed", { service, conversationId, error: String(err) });
          }
        }
      }
    }
    this.onChange();
  }

  /** Mark-unread applies to the unified view only (PRD assumption). */
  async markUnread(keys: string[]): Promise<void> {
    for (const key of keys) {
      const [service, ...rest] = key.split(":") as [Service, ...string[]];
      const existing = this.store.getConversation(service, rest.join(":"));
      if (!existing) continue;
      existing.state.unread = true;
      existing.state.unreadCount = Math.max(1, existing.state.unreadCount);
      delete existing.state.readAt;
      this.store.putConversation(existing.state);
    }
    this.onChange();
  }

  async markAllRead(): Promise<void> {
    const keys = this.store
      .allConversations()
      .filter((c) => c.state.unread)
      .map((c) => c.row.key);
    await this.markRead(keys);
  }
}
