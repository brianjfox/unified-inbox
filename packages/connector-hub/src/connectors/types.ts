import type { HubStatus, InboxEvent, Service } from "@inbox/shared/schema";

/**
 * What every connector gives the hub. The hub owns normalization into
 * conversation artifacts, read state, and the relay; a connector owns one
 * service's session and translates in both directions.
 */
export type ConnectorHost = {
  /** A message arrived (or was found during the initial sync). Idempotent on messageId. */
  onMessage(event: InboxEvent): void;
  /** A conversation's display name changed (group renamed, contact resolved). */
  onConversationRenamed(service: Service, conversationId: string, name: string): void;
  /** Connection state changed; the hub re-publishes its status. */
  onStatusChanged(): void;
  /** Structured logging. */
  log: Logger;
};

export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
};

export class ReadBackUnavailableError extends Error {}

export interface Connector {
  readonly service: Service;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Mark a whole conversation read in the source service (FR-7, FR-8). Throws
   * ReadBackUnavailableError where the service offers no safe way.
   */
  markRead(conversationId: string): Promise<void>;
}

export interface SlackConnector extends Connector {
  readonly service: "slack";
  status(): HubStatus["slack"];
  /** One-time app settings. Validates shape, stores in the keychain, (re)starts Socket Mode. */
  saveApp(settings: { clientId: string; clientSecret: string; appToken: string }): Promise<void>;
  /** Begins the authorization-code flow for a viewer; returns Slack's authorize URL. */
  startConnect(viewerDeviceId: string, redirectUri: string): Promise<{ url: string }>;
  /** Finishes it: verifies state, exchanges the code on this machine, stores the token. */
  finishConnect(viewerDeviceId: string, code: string, state: string, redirectUri: string): Promise<{ teamId: string; teamName: string }>;
  removeWorkspace(teamId: string): Promise<void>;
}

export interface WhatsAppConnector extends Connector {
  readonly service: "whatsapp";
  status(): HubStatus["whatsapp"];
  /**
   * Start (or restart) linking. Each QR refresh calls `onQr`; `onLinked` fires
   * once the phone has scanned. Returns a function that cancels the attempt.
   */
  link(handlers: { onQr(qr: string): void; onLinked(): void; onError(message: string): void }): Promise<() => void>;
}

export interface IMessageConnector extends Connector {
  readonly service: "imessage";
  status(): HubStatus["imessage"];
  setPaused(paused: boolean): Promise<void>;
}
