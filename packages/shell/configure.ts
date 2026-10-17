#!/usr/bin/env bun
/**
 * Writes the shell's generated Tauri configuration from the templates in
 * ./templates. The relay origin is a configure-time value (ADR-8): the shell
 * pins it as the main window's URL and as the only remote origin allowed to
 * call its commands.
 *
 *   INBOX_RELAY_URL=https://inbox.example.net bun run configure
 *
 * Optional signing inputs, read when set:
 *   APPLE_SIGNING_IDENTITY        -> bundle.macOS.signingIdentity
 *   WINDOWS_CERTIFICATE_THUMBPRINT -> bundle.windows.certificateThumbprint
 *   WINDOWS_SIGN_COMMAND           -> bundle.windows.signCommand (a command with {{path}})
 *
 * Generated files (gitignored): src-tauri/tauri.conf.json,
 * src-tauri/capabilities/remote.json.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);

export function relayOriginFromEnv(env: Record<string, string | undefined>): string {
  const raw = env.INBOX_RELAY_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      "INBOX_RELAY_URL is not set. It is the origin the relay serves the GUI from, for example\n" +
        "  INBOX_RELAY_URL=http://localhost:8787 bun run configure   (development)\n" +
        "  INBOX_RELAY_URL=https://inbox.example.net bun run configure   (production)",
    );
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`INBOX_RELAY_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`INBOX_RELAY_URL must start with http:// or https://, got ${raw}`);
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`INBOX_RELAY_URL uses plain http:// for a non-local host (${url.hostname}); the shell pins the relay over HTTPS (ADR-8).`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username) {
    throw new Error(`INBOX_RELAY_URL must be an origin only (scheme://host[:port]), got ${raw}`);
  }
  return url.origin;
}

type Json = Record<string, unknown>;

export function renderTauriConf(template: Json, origin: string, env: Record<string, string | undefined>): Json {
  const text = JSON.stringify(template).replaceAll("__INBOX_RELAY_URL__", origin);
  const conf = JSON.parse(text) as Json;
  const bundle = conf.bundle as Json;
  const macOS = bundle.macOS as Json;
  const windows = bundle.windows as Json;
  if (env.APPLE_SIGNING_IDENTITY) macOS.signingIdentity = env.APPLE_SIGNING_IDENTITY;
  if (env.WINDOWS_CERTIFICATE_THUMBPRINT) windows.certificateThumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT;
  if (env.WINDOWS_SIGN_COMMAND) windows.signCommand = env.WINDOWS_SIGN_COMMAND;
  return conf;
}

export function renderCapability(template: Json, origin: string): Json {
  // Tauri's remote URL patterns use the URLPattern syntax; the host must match
  // exactly and any path on that origin may call the commands.
  const text = JSON.stringify(template).replaceAll("__INBOX_RELAY_URL_PATTERN__", `${origin}/*`);
  return JSON.parse(text) as Json;
}

async function main() {
  const origin = relayOriginFromEnv(process.env);
  const confTemplate = (await Bun.file(join(here, "templates/tauri.conf.template.json")).json()) as Json;
  const capTemplate = (await Bun.file(join(here, "templates/remote.capability.template.json")).json()) as Json;
  const conf = renderTauriConf(confTemplate, origin, process.env);
  const cap = renderCapability(capTemplate, origin);
  const confPath = join(here, "src-tauri/tauri.conf.json");
  const capPath = join(here, "src-tauri/capabilities/remote.json");
  await mkdir(dirname(capPath), { recursive: true });
  await Bun.write(confPath, JSON.stringify(conf, null, 2) + "\n");
  await Bun.write(capPath, JSON.stringify(cap, null, 2) + "\n");
  console.log(`shell: relay origin ${origin}`);
  console.log(`shell: wrote ${confPath}`);
  console.log(`shell: wrote ${capPath}`);
  const signing = (conf.bundle as Json).macOS as Json;
  console.log(`shell: macOS signing identity ${signing.signingIdentity ? String(signing.signingIdentity) : "(none; set APPLE_SIGNING_IDENTITY to sign)"}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`shell configure: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
