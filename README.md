# Unified Inbox

One inbox for your iMessage, Slack, and WhatsApp direct messages: read and triage everywhere, reply in the source app. This repository holds everything that ships:

| Package | What it is | Runs on |
|---|---|---|
| `packages/relay` | The sync relay: an Interchange-shaped host around `@corbits/artifacts` and `@corbits/mailbox`, with device-signature authentication. Stores and relays only ciphertext. Also serves the GUI. | Bun, on a DigitalOcean droplet or any Linux host |
| `packages/gui` | The web GUI (React + `@corbits/react-ui`), built to `packages/gui/dist` and served by the relay. Mobile-responsive. | Any browser, and the desktop shell |
| `packages/shell` | The thin Tauri desktop shell for macOS and Windows. Loads the GUI from the relay and adds native Reply handoff. | macOS, Windows |
| `packages/connector-hub` | The connector hub: one process on the always-on Mac holding the iMessage, Slack and WhatsApp connections; the sole writer of read state. | Node 26 on the Mac, as a launchd agent |
| `packages/shared` | Schema, protocol, end-to-end crypto layer, relay client, deep-link resolver. | Everywhere |
| `packages/seed` | The seed script: loads the recent window of real messages through the normal pipeline. | Node 26 on the Mac |
| `packages/provision` | The idempotent DigitalOcean provisioning script for the relay (`--create` or `--host`). | Bun, anywhere `doctl` and `ssh` work |

This README is for whoever installs and runs the system. People who use the inbox read `docs/USER-MANUAL.md`. Open product decisions and build-time gaps are in `QUESTIONS.md`.

## How the pieces fit

```
 Mac (always on)                    DigitalOcean droplet                 Your machines and phone
 ┌───────────────────────┐          ┌──────────────────────────┐         ┌───────────────────────────┐
 │ connector hub (Node)  │ sealed   │ relay (Bun)              │ sealed  │ GUI in the Tauri shell    │
 │  iMessage ─┐          │ blobs    │  Postgres: ciphertext    │ blobs   │ (macOS, Windows) or in a  │
 │  Slack ────┼─normalize├─────────▶│  artifacts + mailbox     │◀────────┤ phone browser             │
 │  WhatsApp ─┘  + seal  │◀─────────┤  device auth, grants     ├────────▶│  local SQLite cache       │
 │  keychain: keys,tokens│ sealed   │  serves packages/gui/dist│ sealed  │  keys in browser storage  │
 └───────────────────────┘ events   └──────────────────────────┘ events  └───────────────────────────┘
```

- Every message is sealed with an **inbox key** that only your devices hold; the relay never has it (NFR-2, AC-18).
- Every device (the hub and each viewer) has its own keypair. Requests to the relay are signed with it; nothing has a password.
- Viewer ↔ hub traffic (read state, Slack authorization, WhatsApp QR) travels as sealed envelopes through the relay's mailbox.
- Credentials (Slack app settings and tokens, the WhatsApp session key) live only in the Mac's keychain.

## Running in development

Requirements: **Bun 1.2+**, **Node 24+** (26 used here), **macOS** for the connector hub (it uses the macOS keychain and reads Messages). Postgres is optional: if nothing listens on `localhost:5432`, the dev script serves an in-process PGlite over the Postgres wire protocol instead.

```sh
bun install
bun run dev
```

That one command:

1. picks the database (your local Postgres and a `unified_inbox` database it creates if missing, or PGlite in `tmp/pglite`),
2. builds the GUI and keeps rebuilding it on change,
3. starts the relay on `http://localhost:8787`, which runs its migrations and serves the GUI,
4. starts the connector hub pointed at that relay, with its data in `tmp/hub` and its keychain items under the service name `com.unified-inbox.hub.dev`.

Open `http://localhost:8787/`. The browser enrolls itself as a viewer; the hub approves the first viewer automatically (see `QUESTIONS.md`, item 1). No account and no key are needed to get this far. Slack and WhatsApp are connected later from the Connections screen; until then each card says what to do. iMessage needs Full Disk Access for the `node` binary (System Settings → Privacy & Security → Full Disk Access), after which the next poll picks it up without a restart.

How to tell it is running: `curl http://localhost:8787/api/health` answers `{"ok":true,...}`; the GUI's sidebar shows "Mac hub online"; the Connections screen's hub card shows a recent heartbeat.

### Tests

```sh
bun test                                   # shared, relay (needs Postgres: TEST_DATABASE_URL, default postgres://localhost:5432/unified_inbox_test), gui, provision
cd packages/connector-hub && bun run test  # node --test: store, normalizer, the three connectors (fixture chat.db, fake Slack API server, Baileys auth-state round trips)
bun run typecheck
```

The relay tests include the server-side plaintext inspection (AC-18) and the device-signature checks. Nothing in the test suite talks to Slack, WhatsApp, Apple, or DigitalOcean.

## Environment variables

### Relay (`packages/relay`)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/dbname`. Without a user, the local OS user is used (Homebrew Postgres). The relay runs all migrations on every start. |
| `RELAY_PORT` | no (8787) | Listening port. |
| `RELAY_HOST` | no (127.0.0.1) | Bind address. Behind Caddy, keep it loopback. |
| `RELAY_PUBLIC_ORIGIN` | in production | The origin devices reach, e.g. `https://inbox.example.net`. Also the Slack redirect URL's origin. |
| `RELAY_MAIL_DOMAIN` | no | Mail domain for device addresses; defaults to the public origin's hostname. |
| `RELAY_GUI_DIR` | no | Directory with the built GUI; defaults to `packages/gui/dist`. |

### Connector hub (`packages/connector-hub`)

| Variable | Required | Meaning |
|---|---|---|
| `RELAY_URL` | yes | The relay's public origin. |
| `HUB_LABEL` | no (computer name) | How this Mac appears on the Connections screen. |
| `HUB_DATA_DIR` | no (`~/Library/Application Support/UnifiedInbox`) | SQLite state (`hub.db`). No credentials are stored here in the clear. |
| `HUB_KEYCHAIN_SERVICE` | no (`com.unified-inbox.hub`) | Keychain service name for the hub's keys and tokens. |
| `HUB_HEARTBEAT_MS`, `HUB_MAILBOX_POLL_MS`, `HUB_IMESSAGE_POLL_MS` | no (30000, 3000, 15000) | Timers. |
| `HUB_IMESSAGE_DB` | no (`~/Library/Messages/chat.db`) | Path to the Messages database. |
| `HUB_LOG_LEVEL` | no (`info`) | `debug`, `info`, `warn`, `error`. |

No service credential is ever an environment variable: Slack app settings and tokens are entered on the Connections screen and stored in the keychain; the WhatsApp session is linked by QR code from the same screen.

### Desktop shell (`packages/shell`)

| Variable | Required | Meaning |
|---|---|---|
| `INBOX_RELAY_URL` | yes, at configure time | The relay origin the shell loads. `bun run configure` writes it into the Tauri config. |
| `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | for signed macOS builds | Tauri's signing and notarization variables. |
| `TAURI_SIGNING_PRIVATE_KEY` and Windows certificate variables | for signed Windows builds | See `packages/shell/README.md`. |

### Seed and provisioning

The seed script uses the hub's variables. The provisioning script reads DigitalOcean credentials from `doctl`'s own authentication and takes everything else as flags.

## Deploying

### 1. Relay on DigitalOcean

```sh
bun run packages/gui/build            # the provisioning script ships packages/gui/dist
packages/provision/provision.ts --create --name unified-inbox-relay --region sfo3 --size s-1vcpu-1gb --domain inbox.example.net
# or, on a host you already have:
packages/provision/provision.ts --host 203.0.113.10 --domain inbox.example.net
```

Point the domain's DNS A record at the droplet before the first run; Caddy obtains the certificate. Rerunning the script is the upgrade path: it converges and restarts the relay only when code or configuration changed. `--dry-run` prints the plan. Details, including what the script installs and where (`/opt/unified-inbox`, `/etc/unified-inbox/relay.env`, `unified-inbox-relay.service`), are in `packages/provision/README.md`.

What the relay needs from its surroundings: a Postgres database (the script installs one locally), outbound HTTPS for Caddy's certificate, and inbound 80/443.

### 2. Connector hub on the always-on Mac

```sh
git clone <this repository> ~/unified-inbox && cd ~/unified-inbox && bun install
RELAY_URL=https://inbox.example.net packages/connector-hub/install-hub.sh
```

This installs a launchd agent (`com.unified-inbox.hub`) that starts at login, restarts itself, and logs to `~/Library/Logs/UnifiedInbox/`. Then grant Full Disk Access to the `node` binary the installer printed and restart the agent (`launchctl kickstart -k gui/$(id -u)/com.unified-inbox.hub`). The first hub to enroll is approved by the relay itself. `install-hub.sh --uninstall` removes it.

### 3. Viewers

- **Desktop:** `cd packages/shell && INBOX_RELAY_URL=https://inbox.example.net bun run configure && bun run build`. Install the `.dmg` (macOS) or the NSIS installer (Windows) it produces. Signing details in `packages/shell/README.md`.
- **Phone:** open `https://inbox.example.net` in the browser. No install.

Each viewer enrolls itself on first open and waits for approval. The hub approves the first viewer; every later one is approved from an approved viewer's Connections → Sync & encryption card.

### 4. Slack, WhatsApp, iMessage

On the Connections screen: open **Slack app settings** once, create the Slack app it describes (public distribution on, Socket Mode on with an app-level token, user event subscriptions `message.im` and `message.mpim`, the listed user-token scopes, and the shown redirect URL), save the client ID, client secret and app-level token, then **Connect a workspace** and approve at Slack, once per workspace. For WhatsApp, **Show QR code** and scan from the phone (WhatsApp → Settings → Linked devices). iMessage needs only Full Disk Access on the Mac.

### 5. Seed

```sh
RELAY_URL=https://inbox.example.net bun run --cwd packages/seed seed
```

Runs the connectors' initial sync (the last 14 days) through the normal pipeline and exits when it goes quiet. Safe to run again.

### 6. Confirm

Reboot the Mac once and confirm the hub is back (`launchctl print gui/$(id -u)/com.unified-inbox.hub`, and the Connections screen's hub card). That is AC-1.

### Manual pictures

`docs/USER-MANUAL.md` is illustrated with pictures taken from the running application. To refresh them after a change, start the dev stack and run the capture against it:

```sh
bun run dev                                                   # terminal 1
HUB_PID=$(pgrep -f connector-hub/src/main.ts) bun run manual:screenshots   # terminal 2
```

It drives a headless browser through the main flow (enrollment and approval, the inbox, a thread, search, phone width, Connections, mark all read, and the hub-offline state, which it produces by pausing the hub for the staleness window) and writes `docs/manual/*.png`. The pictures show whatever is in the inbox at the time, so review them before sharing the manual.

## Operations

- **Logs:** hub in `~/Library/Logs/UnifiedInbox/hub.log` and `hub.err.log`; relay via `journalctl -u unified-inbox-relay`.
- **Restart the hub:** the Connections screen's "Restart hub" button, or `launchctl kickstart -k gui/$(id -u)/com.unified-inbox.hub`.
- **Upgrade:** `git pull && bun install` on the Mac then kickstart the hub; rerun the provisioning script for the relay; rebuild the shell when it changes (the GUI updates with the relay).
- **Revoke a device:** Connections → Sync & encryption → Revoke. The relay drops its grants and its wrapped inbox key.
