import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type HubConfig = {
  relayUrl: string;
  tenantId: string;
  /** How this Mac is named on the Connections screen. */
  hubLabel: string;
  dataDir: string;
  keychainService: string;
  /** Milliseconds between heartbeats (plan: 30s). */
  heartbeatMs: number;
  /** Milliseconds between mailbox polls for triage and credential events. */
  mailboxPollMs: number;
  /** Milliseconds between chat.db polls (plan: 15s). */
  imessagePollMs: number;
  /** Path to the Messages database. */
  imessageDbPath: string;
  /** Folder holding the Contacts databases that name iMessage handles. */
  contactsDir: string;
  version: string;
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const relayUrl = env.RELAY_URL ?? "http://localhost:8787";
  try {
    new URL(relayUrl);
  } catch {
    throw new ConfigError(`RELAY_URL is not a URL: ${relayUrl}`);
  }
  return {
    relayUrl: relayUrl.replace(/\/$/, ""),
    tenantId: env.RELAY_TENANT ?? "inbox",
    hubLabel: env.HUB_LABEL ?? hostname().replace(/\.local$/, ""),
    dataDir: env.HUB_DATA_DIR ?? join(homedir(), "Library", "Application Support", "UnifiedInbox"),
    keychainService: env.HUB_KEYCHAIN_SERVICE ?? "com.unified-inbox.hub",
    heartbeatMs: Number(env.HUB_HEARTBEAT_MS ?? 30_000),
    mailboxPollMs: Number(env.HUB_MAILBOX_POLL_MS ?? 3_000),
    imessagePollMs: Number(env.HUB_IMESSAGE_POLL_MS ?? 15_000),
    imessageDbPath: env.HUB_IMESSAGE_DB ?? join(homedir(), "Library", "Messages", "chat.db"),
    contactsDir: env.HUB_CONTACTS_DIR ?? join(homedir(), "Library", "Application Support", "AddressBook"),
    version: env.HUB_VERSION ?? "0.1.0",
  };
}
