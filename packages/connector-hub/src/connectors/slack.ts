import { buildAuthorizeUrl, generatePkce, generateState } from "@corbits/oauth-core";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { HubStatus, SlackWorkspaceStatus } from "@inbox/shared/schema";
import type { HubConfig } from "../config.ts";
import type { Keychain } from "../keychain.ts";
import type { HubStore } from "../store.ts";
import type { ConnectorHost, Logger, SlackConnector } from "./types.ts";
import { asChannelType, asEventsApiBody, classifyMessage, teamIdOf, type SocketModeEnvelope } from "./slack/events.ts";
import { slackErrorMessage } from "./slack/errors.ts";
import { slackSdkLogger } from "./slack/logger.ts";
import { teamDomainFromUrl } from "./slack/text.ts";
import { WorkspaceSession, channelTeamKey, type WorkspaceInfo } from "./slack/workspace.ts";

/**
 * The Slack connector (build plan task 5, ADR-10). One registered Slack app,
 * saved once; one user token (xoxp) per workspace, obtained by click-through
 * authorization whose code is exchanged on this Mac; direct messages over
 * Socket Mode; read-back with `conversations.mark`.
 *
 * Credentials live only in the keychain (NFR-3): the app settings under
 * "slack-app" and each workspace's token under "slack-token-<teamId>". The
 * store keeps non-secret workspace metadata and bookkeeping.
 */
export type SlackConnectorDeps = {
  host: ConnectorHost;
  store: HubStore;
  keychain: Keychain;
  config: HubConfig;
  log: Logger;
  /**
   * Base URL of Slack's Web API. The real one by default; the tests point it
   * at a local server that speaks Slack's wire format. Also read from the
   * SLACK_API_URL environment variable.
   */
  slackApiUrl?: string;
};

/** The connector plus the two hooks the tests and the hub's shutdown use. */
export type SlackConnectorHandle = SlackConnector & {
  /** Handles one Socket Mode envelope exactly as the live connection would. */
  handleSocketEvent(envelope: SocketModeEnvelope): Promise<void>;
  /** Resolves once every background fetch started so far has finished. */
  whenIdle(): Promise<void>;
};

export const SLACK_APP_KEYCHAIN_KEY = "slack-app";
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_USER_SCOPES = ["im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read"] as const;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SLACK_API_URL = "https://slack.com/api/";

export function tokenKeychainKey(teamId: string): string {
  return `slack-token-${teamId}`;
}

type AppSettings = { clientId: string; clientSecret: string; appToken: string };

type SocketState = "off" | "connecting" | "connected" | "error";

export function createSlackConnector(deps: SlackConnectorDeps): SlackConnectorHandle {
  return new SlackConnectorImpl(deps);
}

class SlackConnectorImpl implements SlackConnectorHandle {
  readonly service = "slack" as const;
  private readonly slackApiUrl: string;
  private readonly log: Logger;
  private app: AppSettings | null = null;
  /** Set when the keychain holds app settings that cannot be read as such. */
  private appError: string | null = null;
  private readonly sessions = new Map<string, WorkspaceSession>();
  /** Workspaces listed in the store whose token is missing from the keychain. */
  private readonly orphanWorkspaces = new Map<string, { info: WorkspaceInfo; error: string }>();
  private socket: SocketModeClient | null = null;
  private socketState: SocketState = "off";
  private socketError: string | null = null;
  private stopped = false;
  private readonly tasks = new Set<Promise<void>>();
  private readonly deps: SlackConnectorDeps;

  constructor(deps: SlackConnectorDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.slackApiUrl = deps.slackApiUrl ?? process.env.SLACK_API_URL ?? DEFAULT_SLACK_API_URL;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadApp();
    for (const row of this.deps.store.slackWorkspaces()) {
      const info: WorkspaceInfo = { teamId: row.team_id, name: row.name, teamDomain: row.team_domain, userId: row.user_id, authorizedAt: row.authorized_at };
      const token = await this.deps.keychain.get(tokenKeychainKey(info.teamId));
      if (!token) {
        this.orphanWorkspaces.set(info.teamId, { info, error: "Its token is missing from the keychain; remove the workspace and connect it again." });
        this.log.warn("slack workspace has no token in the keychain", { teamId: info.teamId });
        continue;
      }
      this.sessions.set(info.teamId, this.newSession(info, token));
    }
    if (!this.app) {
      this.log.info("slack not configured; waiting for app settings from the Connections screen");
    } else if (this.sessions.size === 0) {
      this.log.info("slack app saved; no workspace connected yet");
    } else {
      this.connectSocket();
      for (const session of this.sessions.values()) this.track(session.syncHistory(() => !this.stopped));
    }
    this.deps.host.onStatusChanged();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.dropSocket();
    await this.whenIdle();
  }

  whenIdle(): Promise<void> {
    const settle = async (): Promise<void> => {
      while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    };
    return settle();
  }

  private track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((err: unknown) => this.log.error("slack background task failed", { error: slackErrorMessage(err) }))
      .finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  // ---- status --------------------------------------------------------------

  status(): HubStatus["slack"] {
    const appConfigured = this.app !== null;
    const workspaces: SlackWorkspaceStatus[] = [];
    for (const s of this.sessions.values()) {
      const error = s.error ?? (this.socketState === "error" ? this.socketError : null);
      workspaces.push({ teamId: s.teamId, name: s.info.name, authorizedAt: s.info.authorizedAt, connected: this.socketState === "connected" && !s.error, ...(error ? { error } : {}) });
    }
    for (const o of this.orphanWorkspaces.values()) {
      workspaces.push({ teamId: o.info.teamId, name: o.info.name, authorizedAt: o.info.authorizedAt, connected: false, error: o.error });
    }
    workspaces.sort((a, b) => a.authorizedAt.localeCompare(b.authorizedAt));
    const base = { appConfigured, workspaces };
    if (this.appError) return { state: "error", detail: this.appError, ...base };
    if (!appConfigured) {
      return { state: "not-configured", detail: "Save the Slack app settings (client ID, client secret, app-level token) under Connections → Slack app settings.", ...base };
    }
    if (workspaces.length === 0) return { state: "no-workspaces", detail: "The Slack app is saved. Connect a workspace from the Slack card on the Connections screen.", ...base };
    if (this.socketState === "connected") {
      const n = this.sessions.size;
      return { state: "connected", detail: `Receiving direct messages for ${n} workspace${n === 1 ? "" : "s"} over Socket Mode.`, ...base };
    }
    if (this.socketState === "error") return { state: "error", detail: this.socketError ?? "Socket Mode connection failed.", ...base };
    if (this.sessions.size === 0) return { state: "error", detail: "Every listed workspace is missing its token; remove and reconnect them.", ...base };
    return { state: "error", detail: "Connecting to Slack over Socket Mode; messages arrive once the connection is up.", ...base };
  }

  private changed(): void {
    this.deps.host.onStatusChanged();
  }

  // ---- app settings --------------------------------------------------------

  private async loadApp(): Promise<void> {
    const raw = await this.deps.keychain.get(SLACK_APP_KEYCHAIN_KEY);
    if (raw === null) {
      this.app = null;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      this.app = validateApp(parsed);
      this.appError = null;
    } catch (err) {
      this.app = null;
      this.appError = `The Slack app settings in the keychain are unreadable (${err instanceof Error ? err.message : String(err)}); save them again under Connections → Slack app settings.`;
      this.log.error("slack app settings unreadable", { error: this.appError });
    }
  }

  async saveApp(settings: { clientId: string; clientSecret: string; appToken: string }): Promise<void> {
    const app = validateApp(settings);
    await this.deps.keychain.set(SLACK_APP_KEYCHAIN_KEY, JSON.stringify(app));
    this.app = app;
    this.appError = null;
    this.log.info("slack app settings saved", { clientId: app.clientId });
    await this.dropSocket();
    if (this.sessions.size > 0) this.connectSocket();
    this.changed();
  }

  private requireApp(): AppSettings {
    if (!this.app) throw new Error("Slack app settings have not been saved; open Connections → Slack app settings and save the client ID, client secret and app-level token first.");
    return this.app;
  }

  // ---- authorization-code flow (ADR-10) -----------------------------------

  async startConnect(viewerDeviceId: string, redirectUri: string): Promise<{ url: string }> {
    const app = this.requireApp();
    if (!redirectUri) throw new Error("A redirect URL is required to start a Slack authorization.");
    const state = generateState();
    this.deps.store.putOauthState(state, viewerDeviceId, redirectUri);
    // Slack takes the user-token scopes in `user_scope` and ignores PKCE, so the
    // helper's `scopes` stays empty and the PKCE pair exists only to satisfy its
    // signature; the verifier is never needed because the exchange below uses
    // the client secret.
    const url = buildAuthorizeUrl(
      {
        authorizeUrl: SLACK_AUTHORIZE_URL,
        tokenUrl: `${this.slackApiUrl}oauth.v2.access`,
        clientId: app.clientId,
        redirectUri,
        scopes: [],
        extraAuthorizeParams: { user_scope: SLACK_USER_SCOPES.join(",") },
        tokenTimeoutMs: 30_000,
      },
      generatePkce(),
      state,
    );
    this.log.info("slack authorization started", { viewerDeviceId });
    return { url };
  }

  async finishConnect(viewerDeviceId: string, code: string, state: string, redirectUri: string): Promise<{ teamId: string; teamName: string }> {
    const app = this.requireApp();
    const pending = this.deps.store.takeOauthState(state);
    if (!pending) throw new Error("This Slack authorization was not started by this hub, or it was already used. Press Connect a workspace again.");
    if (pending.viewer_device_id !== viewerDeviceId) throw new Error("This Slack authorization was started from a different device. Press Connect a workspace again on this one.");
    if (pending.redirect_uri !== redirectUri) throw new Error("This Slack authorization returned to a different redirect URL than it was started with. Press Connect a workspace again.");
    if (Date.now() - Date.parse(pending.created_at) > OAUTH_STATE_TTL_MS) throw new Error("This Slack authorization expired (it is valid for 10 minutes). Press Connect a workspace again.");
    if (!code) throw new Error("Slack returned no authorization code.");

    // Slack's token response is not RFC 6749-shaped: the user token is at
    // `authed_user.access_token`, not `access_token` (which is the bot token
    // when there is one). oauth-core's `exchangeCode` validates the standard
    // shape, so the exchange goes through Slack's own client instead. It runs
    // here, on the Mac that holds the client secret (FR-25).
    const anonymous = new WebClient(undefined, { slackApiUrl: this.slackApiUrl, logger: slackSdkLogger(this.log, "slack-web") });
    let access;
    try {
      access = await anonymous.oauth.v2.access({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri });
    } catch (err) {
      throw new Error(`Slack refused the authorization: ${slackErrorMessage(err)}`);
    }
    const token = access.authed_user?.access_token;
    if (!token) throw new Error("Slack's response carried no user token. The app must request the user scopes (user_scope), not bot scopes; check the Slack app's OAuth settings.");

    const client = new WebClient(token, { slackApiUrl: this.slackApiUrl, logger: slackSdkLogger(this.log, "slack-web") });
    let who;
    try {
      who = await client.auth.test({});
    } catch (err) {
      throw new Error(`Slack accepted the code but auth.test failed: ${slackErrorMessage(err)}`);
    }
    const teamId = who.team_id ?? access.team?.id;
    const userId = who.user_id ?? access.authed_user?.id;
    if (!teamId || !userId) throw new Error("Slack did not say which workspace or user the token belongs to (auth.test returned no team_id or user_id).");
    const teamName = who.team ?? access.team?.name ?? teamId;
    const teamDomain = teamDomainFromUrl(who.url);

    await this.deps.keychain.set(tokenKeychainKey(teamId), token);
    this.deps.store.putSlackWorkspace({ teamId, name: teamName, teamDomain, userId });
    const row = this.deps.store.slackWorkspaces().find((w) => w.team_id === teamId);
    const info: WorkspaceInfo = { teamId, name: teamName, teamDomain, userId, authorizedAt: row?.authorized_at ?? new Date().toISOString() };
    this.orphanWorkspaces.delete(teamId);
    const session = this.newSession(info, token);
    this.sessions.set(teamId, session);
    this.log.info("slack workspace connected", { teamId, teamName, viewerDeviceId });
    if (!this.socket) this.connectSocket();
    this.track(session.syncHistory(() => !this.stopped && this.sessions.get(teamId) === session));
    this.changed();
    return { teamId, teamName };
  }

  async removeWorkspace(teamId: string): Promise<void> {
    const session = this.sessions.get(teamId);
    if (session) await session.revoke();
    await this.deps.keychain.delete(tokenKeychainKey(teamId));
    this.deps.store.deleteSlackWorkspace(teamId);
    this.sessions.delete(teamId);
    this.orphanWorkspaces.delete(teamId);
    this.log.info("slack workspace removed", { teamId });
    if (this.sessions.size === 0) await this.dropSocket();
    this.changed();
  }

  private newSession(info: WorkspaceInfo, token: string): WorkspaceSession {
    return new WorkspaceSession(info, token, {
      store: this.deps.store,
      host: this.deps.host,
      log: this.log,
      slackApiUrl: this.slackApiUrl,
      sdkLogger: slackSdkLogger(this.log, "slack-web"),
    });
  }

  // ---- read-back (FR-7, FR-9) ---------------------------------------------

  async markRead(conversationId: string): Promise<void> {
    const teamId = this.deps.store.getKv(channelTeamKey(conversationId));
    if (!teamId) throw new Error(`Slack conversation ${conversationId} has not been seen by any connected workspace, so it cannot be marked read.`);
    const session = this.sessions.get(teamId);
    if (!session) throw new Error(`Slack workspace ${teamId} is no longer connected, so ${conversationId} cannot be marked read.`);
    const marked = await session.markRead(conversationId);
    if (!marked) this.log.debug("slack markRead: no message seen yet for this conversation", { conversationId });
  }

  // ---- Socket Mode ---------------------------------------------------------

  /** Opens the one Socket Mode connection for the app, in the background; state lands in status(). */
  private connectSocket(): void {
    const app = this.app;
    if (!app || this.socket || this.stopped) return;
    const client = new SocketModeClient({
      appToken: app.appToken,
      autoReconnectEnabled: true,
      logger: slackSdkLogger(this.log, "slack-socket"),
      clientOptions: { slackApiUrl: this.slackApiUrl },
    });
    this.socket = client;
    this.socketState = "connecting";
    this.socketError = null;
    const mine = () => this.socket === client;
    client.on("connected", () => {
      if (!mine()) {
        // start() still opens the WebSocket after a disconnect() that raced its URL fetch; close it.
        void client.disconnect().catch((err: unknown) => this.log.warn("slack socket mode late disconnect failed", { error: slackErrorMessage(err) }));
        return;
      }
      this.socketState = "connected";
      this.socketError = null;
      this.log.info("slack socket mode connected");
      this.changed();
    });
    client.on("reconnecting", () => {
      if (!mine() || this.socketState === "connecting") return;
      this.socketState = "connecting";
      this.log.warn("slack socket mode reconnecting");
      this.changed();
    });
    client.on("disconnected", () => {
      if (!mine() || this.socketState !== "connected") return;
      this.socketState = "connecting";
      this.changed();
    });
    client.on("error", (err: unknown) => {
      this.log.warn("slack socket mode error", { error: slackErrorMessage(err) });
    });
    client.on("slack_event", (envelope: SocketModeEnvelope) => {
      void this.handleSocketEvent(envelope).catch((err: unknown) => this.log.error("slack event handling failed", { error: slackErrorMessage(err) }));
    });
    client.start().then(
      () => undefined,
      (err: unknown) => {
        if (!mine()) return;
        this.socketState = "error";
        this.socketError = `Socket Mode could not connect: ${slackErrorMessage(err)}. Check the app-level token (xapp-…) and that Socket Mode is enabled on the Slack app.`;
        this.log.error("slack socket mode failed to start", { error: slackErrorMessage(err) });
        this.changed();
      },
    );
  }

  private async dropSocket(): Promise<void> {
    const client = this.socket;
    this.socket = null;
    this.socketState = "off";
    this.socketError = null;
    if (!client) return;
    client.removeAllListeners("slack_event");
    try {
      await client.disconnect();
    } catch (err) {
      this.log.warn("slack socket mode disconnect failed", { error: slackErrorMessage(err) });
    }
  }

  /**
   * One envelope from Socket Mode. Acknowledged first (Slack resends
   * unacknowledged envelopes), then handled when it is a person's direct
   * message in a workspace this hub holds a token for.
   */
  async handleSocketEvent(envelope: SocketModeEnvelope): Promise<void> {
    await envelope.ack();
    if (envelope.type !== "events_api") return;
    const body = asEventsApiBody(envelope.body);
    if (!body) return;
    const classified = classifyMessage(body.event);
    if ("ignored" in classified) {
      this.log.debug("slack event ignored", { reason: classified.ignored });
      return;
    }
    const message = classified.message;
    const kind = asChannelType(message.channel_type);
    if (!kind || !message.channel) {
      this.log.debug("slack event ignored", { reason: `channel_type ${message.channel_type ?? "none"}` });
      return;
    }
    const teamId = teamIdOf(body, message);
    const session = teamId ? this.sessions.get(teamId) : undefined;
    if (!session) {
      this.log.debug("slack event for a workspace this hub does not hold", { teamId });
      return;
    }
    try {
      await session.emit(message, message.channel, kind);
    } catch (err) {
      this.log.error("slack message could not be normalized", { teamId: session.teamId, channel: message.channel, error: slackErrorMessage(err) });
      throw err;
    }
  }
}

function validateApp(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null) throw new Error("Slack app settings must include a client ID, a client secret and an app-level token.");
  const v = value as Record<string, unknown>;
  const clientId = typeof v.clientId === "string" ? v.clientId.trim() : "";
  const clientSecret = typeof v.clientSecret === "string" ? v.clientSecret.trim() : "";
  const appToken = typeof v.appToken === "string" ? v.appToken.trim() : "";
  if (!clientId) throw new Error("The Slack client ID is missing.");
  if (!clientSecret) throw new Error("The Slack client secret is missing.");
  if (!appToken.startsWith("xapp-")) throw new Error("The Slack app-level token must start with \"xapp-\" (Basic Information → App-Level Tokens, scope connections:write).");
  return { clientId, clientSecret, appToken };
}
