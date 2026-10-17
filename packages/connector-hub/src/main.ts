#!/usr/bin/env node --experimental-strip-types --no-warnings
import { join } from "node:path";
import type { HubStatus, Service } from "@inbox/shared/schema";
import type { HubBoundEvent } from "@inbox/shared/protocol";
import { loadConfig, ConfigError } from "./config.ts";
import { createMacKeychain, KeychainError } from "./keychain.ts";
import { HubStore, conversationKey } from "./store.ts";
import { establishIdentity, approveFirstViewerIfNeeded, EnrollmentPendingError } from "./identity.ts";
import { SyncClient, type ReplyFn } from "./sync.ts";
import { Normalizer } from "./normalizer.ts";
import { createLogger } from "./log.ts";
import type { Connector, ConnectorHost } from "./connectors/types.ts";
import { createSlackConnector } from "./connectors/slack.ts";
import { createIMessageConnector } from "./connectors/imessage.ts";
import { createWhatsAppConnector } from "./connectors/whatsapp.ts";

/**
 * The connector hub (FR-1): one process on the always-on Mac that holds every
 * service connection, normalizes messages, seals them, syncs them through the
 * relay, and is the sole writer of read state back into the services.
 */
export async function runHub(): Promise<() => Promise<void>> {
  const log = createLogger("hub");
  const config = loadConfig();
  const keychain = createMacKeychain(config.keychainService);
  const store = new HubStore(join(config.dataDir, "hub.db"));
  const identity = await establishIdentity(config, keychain, log);
  const health = await identity.relay.health();
  const sync = new SyncClient(identity, store, log, { mailDomain: health.mailDomain });

  let statusDirty = true;
  const host: ConnectorHost = {
    onMessage: (event) => normalizer.ingest(event),
    onConversationRenamed: (service, id, name) => normalizer.rename(service, id, name),
    onStatusChanged: () => {
      statusDirty = true;
    },
    log: createLogger("connector"),
  };

  const slack = createSlackConnector({ host, store, keychain, config, log: createLogger("slack") });
  const imessage = createIMessageConnector({ host, store, config, log: createLogger("imessage") });
  const whatsapp = createWhatsAppConnector({ host, store, keychain, config, log: createLogger("whatsapp") });
  const connectors = new Map<Service, Connector>([
    ["slack", slack],
    ["imessage", imessage],
    ["whatsapp", whatsapp],
  ]);
  const normalizer = new Normalizer(store, connectors, log, () => {
    void sync.flush().catch((err) => log.error("flush failed", { error: String(err) }));
  });

  const status = (): HubStatus => ({
    v: 1,
    at: new Date().toISOString(),
    hubName: config.hubLabel,
    version: config.version,
    imessage: imessage.status(),
    slack: slack.status(),
    whatsapp: whatsapp.status(),
  });

  /** One active WhatsApp link attempt at a time; a new request cancels the old. */
  let cancelLink: (() => void) | null = null;

  const dispatch = async (event: HubBoundEvent, from: { id: string; label: string }, reply: ReplyFn) => {
    log.info("event", { type: event.type, from: from.label });
    switch (event.type) {
      case "triage.markRead":
        await normalizer.markRead(event.conversationIds);
        return reply({ type: "reply.ok" });
      case "triage.markUnread":
        await normalizer.markUnread(event.conversationIds);
        return reply({ type: "reply.ok" });
      case "triage.markAllRead":
        await normalizer.markAllRead();
        return reply({ type: "reply.ok" });
      case "slack.saveApp":
        await slack.saveApp({ clientId: event.clientId, clientSecret: event.clientSecret, appToken: event.appToken });
        statusDirty = true;
        return reply({ type: "reply.ok" });
      case "slack.startConnect": {
        const { url } = await slack.startConnect(from.id, event.redirectUri);
        return reply({ type: "slack.authorizeUrl", url });
      }
      case "slack.finishConnect": {
        const team = await slack.finishConnect(from.id, event.code, event.state, event.redirectUri);
        statusDirty = true;
        return reply({ type: "slack.connected", teamId: team.teamId, teamName: team.teamName });
      }
      case "slack.removeWorkspace":
        await slack.removeWorkspace(event.teamId);
        statusDirty = true;
        return reply({ type: "reply.ok" });
      case "whatsapp.link": {
        cancelLink?.();
        cancelLink = await whatsapp.link({
          onQr: (qr: string) => void reply({ type: "whatsapp.qr", qr }).catch((e) => log.warn("qr reply failed", { error: String(e) })),
          onLinked: () => {
            statusDirty = true;
            void reply({ type: "whatsapp.linked" }).catch((e) => log.warn("linked reply failed", { error: String(e) }));
          },
          onError: (message: string) => void reply({ type: "reply.error", message }).catch(() => undefined),
        });
        return;
      }
      case "imessage.setPaused":
        await imessage.setPaused(event.paused);
        statusDirty = true;
        return reply({ type: "reply.ok" });
      case "hub.restart":
        await reply({ type: "reply.ok" });
        log.info("restart requested from a viewer; exiting so launchd restarts the hub");
        setTimeout(() => process.exit(0), 250);
        return;
      case "hub.ping":
        return reply({ type: "reply.ok" });
    }
  };

  for (const c of connectors.values()) {
    try {
      await c.start();
    } catch (err) {
      log.error(`${c.service} connector failed to start; it will report its state on the Connections screen`, { error: String(err) });
    }
  }

  sync.every(config.heartbeatMs, "heartbeat", async () => {
    await sync.heartbeat(status());
    statusDirty = false;
  });
  sync.every(2_000, "status", async () => {
    if (statusDirty) {
      await sync.heartbeat(status());
      statusDirty = false;
    }
  });
  sync.every(config.mailboxPollMs, "mailbox", async () => {
    await sync.pollMailbox(dispatch);
  });
  sync.every(15_000, "bootstrap", async () => {
    await approveFirstViewerIfNeeded(identity, log);
  });
  sync.every(10_000, "flush", async () => {
    await sync.flush();
    store.pruneOauthStates(10 * 60 * 1000);
  });

  log.info("hub running", { deviceId: identity.deviceId, relay: config.relayUrl, label: config.hubLabel });

  return async () => {
    sync.stop();
    cancelLink?.();
    for (const c of connectors.values()) await c.stop().catch(() => undefined);
    store.close();
  };
}

export { conversationKey };

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import("node:path")).resolve(process.argv[1]);
if (isMain) {
  runHub()
    .then((stop) => {
      const shutdown = () => void stop().finally(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err) => {
      if (err instanceof ConfigError || err instanceof KeychainError || err instanceof EnrollmentPendingError) {
        console.error(`connector-hub: ${err.message}`);
        process.exit(2);
      }
      console.error("connector-hub: failed to start", err);
      process.exit(1);
    });
}
