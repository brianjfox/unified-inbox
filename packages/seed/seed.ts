#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The seed script (FR-23, AC-17, AC-P3): loads the recent window of REAL
 * messages from the live accounts into the inbox through the normal pipeline.
 * It runs the connector hub itself on this Mac, waits until the connectors'
 * initial sync has gone quiet, lets the sync client flush, and exits. Running
 * it twice adds nothing: every message is deduplicated by its service id.
 *
 *   RELAY_URL=https://inbox.example.net bun run seed      (or: node seed.ts)
 *
 * Requirements are the hub's: this Mac's keychain, Full Disk Access for
 * iMessage, a Slack app and workspaces authorized, and a linked WhatsApp
 * session. A service without credentials is reported, not faked.
 */
import { join } from "node:path";
import Database from "better-sqlite3";
import { runHub } from "@inbox/connector-hub/main";
import { loadConfig } from "@inbox/connector-hub/config";

const QUIET_MS = Number(process.env.SEED_QUIET_MS ?? 30_000);
const MAX_MS = Number(process.env.SEED_MAX_MS ?? 10 * 60_000);

function counts(dbPath: string): { conversations: number; messages: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const c = db.prepare("SELECT count(*) AS n FROM conversation").get() as { n: number };
    const m = db.prepare("SELECT count(*) AS n FROM seen_message").get() as { n: number };
    return { conversations: c.n, messages: m.n };
  } finally {
    db.close();
  }
}

async function main() {
  const config = loadConfig();
  const dbPath = join(config.dataDir, "hub.db");
  const stop = await runHub();
  const started = Date.now();
  let last = counts(dbPath);
  let lastChange = Date.now();
  console.log(`seed: hub running; waiting for the connectors' initial sync to go quiet (${QUIET_MS / 1000}s without new messages)`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = counts(dbPath);
    if (now.messages !== last.messages || now.conversations !== last.conversations) {
      console.log(`seed: ${now.conversations} conversations, ${now.messages} messages so far`);
      last = now;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= QUIET_MS) break;
    if (Date.now() - started >= MAX_MS) {
      console.log("seed: reached the time limit; stopping with what has arrived so far");
      break;
    }
  }
  // Give the sync client a flush cycle so the relay has every version.
  await new Promise((r) => setTimeout(r, 12_000));
  await stop();
  const dirty = (() => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM conversation WHERE dirty = 1").get() as { n: number }).n;
    } finally {
      db.close();
    }
  })();
  console.log(`seed: done. ${last.conversations} conversations and ${last.messages} messages in the inbox; ${dirty} still waiting to upload (0 means the relay has everything).`);
  process.exit(dirty === 0 ? 0 : 3);
}

main().catch((err) => {
  console.error(`seed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
