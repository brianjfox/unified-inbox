import { WebClient, type Logger as SlackSdkLogger } from "@slack/web-api";
import type { InboxEvent } from "@inbox/shared/schema";
import type { HubStore } from "../../store.ts";
import type { ConnectorHost, Logger } from "../types.ts";
import { classifyMessage, isRecord, type SlackChannelType, type SlackMessage } from "./events.ts";
import { slackErrorMessage } from "./errors.ts";
import { compareSlackTs, displayNameOf, renderSlackText, slackTsDaysAgo, slackTsToIso } from "./text.ts";

/** Non-secret facts about one connected workspace; the token itself stays in the keychain. */
export type WorkspaceInfo = {
  teamId: string;
  name: string;
  teamDomain: string | null;
  /** The person's own user id in this workspace: what makes a message "mine". */
  userId: string;
  authorizedAt: string;
};

export type WorkspaceSessionDeps = {
  store: HubStore;
  host: ConnectorHost;
  log: Logger;
  slackApiUrl: string;
  sdkLogger: SlackSdkLogger;
};

/** How far back the first fetch of a workspace reaches (the seed window). */
export const SEED_WINDOW_DAYS = 14;

export function latestTsKey(teamId: string, channel: string): string {
  return `slack:latest:${teamId}:${channel}`;
}
export function channelTeamKey(channel: string): string {
  return `slack:channel-team:${channel}`;
}

/**
 * One authorized workspace: its user-token WebClient, the names it has
 * resolved, and the translation of Slack messages into InboxEvents. The
 * connector owns the Socket Mode connection (one per app) and hands each
 * event to the session of the workspace it came from.
 */
export class WorkspaceSession {
  readonly client: WebClient;
  /** Why this workspace is not delivering, when it is not; shown on the Connections screen. */
  error: string | null = null;
  private readonly users = new Map<string, string>();
  private readonly conversations = new Map<string, { name: string; isGroup: boolean }>();
  /** For an im seeded from the conversation listing: the other person's id, until their name is resolved. */
  private readonly pendingImUser = new Map<string, string>();
  /** Set when the first history fetch completes without error. */
  private seeded = false;

  readonly info: WorkspaceInfo;
  private readonly deps: WorkspaceSessionDeps;

  constructor(info: WorkspaceInfo, token: string, deps: WorkspaceSessionDeps) {
    this.info = info;
    this.deps = deps;
    this.client = new WebClient(token, { slackApiUrl: deps.slackApiUrl, logger: deps.sdkLogger });
  }

  get teamId(): string {
    return this.info.teamId;
  }

  cachedUserName(userId: string): string | undefined {
    return this.users.get(userId);
  }

  /** Resolves and caches a user's display name through `users.info`. */
  async userName(userId: string): Promise<string> {
    const cached = this.users.get(userId);
    if (cached) return cached;
    const res = await this.client.users.info({ user: userId });
    const name = displayNameOf(res.user ?? {}, userId);
    this.users.set(userId, name);
    return name;
  }

  /** Lets the initial fetch seed an im's counterpart from the conversation listing. */
  seedConversation(channel: string, kind: SlackChannelType, otherUser: string | undefined): void {
    if (kind === "im" && otherUser && !this.conversations.has(channel)) {
      this.conversations.set(channel, { name: "", isGroup: false });
      this.pendingImUser.set(channel, otherUser);
    }
  }

  /**
   * The conversation's display name: for an im, the other person; for an
   * mpim, every member but me, joined with ", ".
   */
  async conversationName(channel: string, kind: SlackChannelType, sender: string): Promise<{ name: string; isGroup: boolean }> {
    const known = this.conversations.get(channel);
    if (known && known.name.length > 0) return known;
    if (kind === "mpim") {
      const members = await this.members(channel);
      const names: string[] = [];
      for (const m of members) if (m !== this.info.userId) names.push(await this.userName(m));
      const entry = { name: names.join(", "), isGroup: true };
      this.conversations.set(channel, entry);
      return entry;
    }
    let other = this.pendingImUser.get(channel);
    if (!other) {
      if (sender !== this.info.userId) other = sender;
      else {
        // Slack returns the counterpart as `channel.user` for an im; the SDK's Channel type leaves it out.
        const res = await this.client.conversations.info({ channel });
        const ch: unknown = res.channel;
        other = isRecord(ch) && typeof ch.user === "string" ? ch.user : undefined;
      }
    }
    if (!other) {
      const entry = { name: "Direct message", isGroup: false };
      this.conversations.set(channel, entry);
      return entry;
    }
    const entry = { name: await this.userName(other), isGroup: false };
    this.conversations.set(channel, entry);
    this.pendingImUser.delete(channel);
    return entry;
  }

  private async members(channel: string): Promise<string[]> {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.members({ channel, limit: 200, cursor });
      all.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return all;
  }

  latestTs(channel: string): string | null {
    return this.deps.store.getKv(latestTsKey(this.teamId, channel));
  }

  private recordTs(channel: string, ts: string): void {
    const latest = this.latestTs(channel);
    if (!latest || compareSlackTs(ts, latest) > 0) this.deps.store.setKv(latestTsKey(this.teamId, channel), ts);
  }

  /** Remembers which workspace a channel belongs to, so markRead can find its token. */
  rememberChannel(channel: string): void {
    this.deps.store.setKv(channelTeamKey(channel), this.teamId);
  }

  /** Translates one Slack message into an InboxEvent and hands it to the hub. */
  async emit(message: SlackMessage, channel: string, kind: SlackChannelType): Promise<void> {
    const sender = message.user ?? this.info.userId;
    this.rememberChannel(channel);
    const conversation = await this.conversationName(channel, kind, sender);
    const senderName = await this.userName(sender);
    const rawText = message.text ?? "";
    const body = rawText.length > 0 ? renderSlackText(rawText, (id) => this.users.get(id)) : (message.files?.length ?? 0) > 0 ? "Sent a file" : "";
    const event: InboxEvent = {
      v: 1,
      service: "slack",
      conversationId: channel,
      conversationName: conversation.name,
      isGroup: conversation.isGroup,
      workspaceId: this.teamId,
      workspaceName: this.info.name,
      messageId: message.ts,
      senderName,
      senderIsMe: sender === this.info.userId,
      body,
      sentAt: slackTsToIso(message.ts),
      link: { slack: { teamId: this.teamId, channelId: channel, ...(this.info.teamDomain ? { teamDomain: this.info.teamDomain } : {}) } },
    };
    this.deps.host.onMessage(event);
    this.recordTs(channel, message.ts);
  }

  /**
   * The initial fetch: every open im and mpim, then its history since the
   * later of the seed window and the newest ts already seen, oldest first.
   * Channels are processed one at a time so the user token stays inside
   * Slack's rate limits; the WebClient waits out any 429 on its own.
   */
  async syncHistory(shouldContinue: () => boolean): Promise<void> {
    const { log } = this.deps;
    const since = slackTsDaysAgo(SEED_WINDOW_DAYS);
    try {
      const channels = await this.listConversations();
      log.info("slack history fetch", { teamId: this.teamId, conversations: channels.length });
      for (const ch of channels) {
        if (!shouldContinue()) return;
        const kind: SlackChannelType = ch.is_mpim ? "mpim" : "im";
        this.rememberChannel(ch.id);
        this.seedConversation(ch.id, kind, ch.user);
        const latest = this.latestTs(ch.id);
        const oldest = latest && compareSlackTs(latest, since) > 0 ? latest : since;
        const messages = await this.history(ch.id, oldest);
        messages.sort((a, b) => compareSlackTs(a.ts, b.ts));
        for (const m of messages) {
          if (!shouldContinue()) return;
          await this.emit(m, ch.id, kind);
        }
      }
      this.seeded = true;
      if (this.error) {
        this.error = null;
        this.deps.host.onStatusChanged();
      }
    } catch (err) {
      this.error = `Fetching Slack history failed: ${slackErrorMessage(err)}`;
      log.error("slack history fetch failed", { teamId: this.teamId, error: slackErrorMessage(err) });
      this.deps.host.onStatusChanged();
    }
  }

  get isSeeded(): boolean {
    return this.seeded;
  }

  private async listConversations(): Promise<Array<{ id: string; is_mpim: boolean; user: string | undefined }>> {
    const out: Array<{ id: string; is_mpim: boolean; user: string | undefined }> = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.users.conversations({ types: "im,mpim", exclude_archived: true, limit: 200, cursor });
      for (const ch of res.channels ?? []) {
        if (typeof ch.id !== "string") continue;
        out.push({ id: ch.id, is_mpim: ch.is_mpim === true, user: typeof ch.user === "string" ? ch.user : undefined });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  private async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.history({ channel, oldest, limit: 200, cursor });
      for (const raw of res.messages ?? []) {
        const c = classifyMessage(raw);
        if ("message" in c) out.push(c.message);
      }
      cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
    } while (cursor);
    return out;
  }

  /** Marks a conversation read in Slack up to the newest message seen. Returns false when nothing is known to mark. */
  async markRead(channel: string): Promise<boolean> {
    const ts = this.latestTs(channel);
    if (!ts) return false;
    await this.client.conversations.mark({ channel, ts });
    return true;
  }

  /** Revokes the user token at Slack. A failure here is logged, not fatal: the token is deleted locally regardless. */
  async revoke(): Promise<void> {
    try {
      await this.client.auth.revoke({});
    } catch (err) {
      this.deps.log.warn("auth.revoke failed; the token is removed locally anyway", { teamId: this.teamId, error: slackErrorMessage(err) });
    }
  }
}
