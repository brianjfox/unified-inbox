#!/usr/bin/env bun
import { loadConfig, ConfigError } from "./config.ts";
import { ensureTenant, migrate, openRelayDb } from "./db.ts";
import { createRelayApp } from "./app.ts";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`relay: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  console.log(`relay: migrating database ${config.db.database} at ${config.db.host}:${config.db.port}`);
  await migrate(config.db);
  const relay = openRelayDb(config.db);
  await ensureTenant(relay, config.tenant);
  const app = createRelayApp(relay, config);
  const server = Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: 32 * 1024 * 1024 });
  console.log(`relay: listening on http://${config.host}:${config.port} (public origin ${config.publicOrigin}); serving GUI from ${config.guiDir}`);
  const shutdown = async () => {
    server.stop(true);
    await relay.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("relay: failed to start", err);
  process.exit(1);
});
