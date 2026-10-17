# Relay provisioning (DigitalOcean, idempotent)

One script serves both lives of the relay: first creation and every later update (ADR-7). Rerunning it is the upgrade path.

```sh
# a new droplet
packages/provision/provision.ts --create --name unified-inbox-relay --region nyc3 --size s-1vcpu-1gb --domain inbox.example.net [--ssh-key <doctl key id>]
# a host you already have
packages/provision/provision.ts --host 203.0.113.10 --domain inbox.example.net [--ssh-user ubuntu]
# see the plan without touching anything (no network needed)
packages/provision/provision.ts --host 203.0.113.10 --domain inbox.example.net --dry-run
```

Requirements on the machine running it: `doctl` authenticated (`doctl auth init`), `ssh`, `rsync`, `curl`, and a built GUI (`bun run build:gui` at the repository root; the script ships `packages/gui/dist`). Point the domain's DNS A record at the host before running; the script warns if it does not resolve and the health check waits for Caddy's certificate.

What a run converges the host to (Ubuntu 24.04 by default):

| Piece | Where | Changed only when |
|---|---|---|
| Bun | `/usr/local/bin/bun` | absent |
| PostgreSQL (apt) | local, with role and database `unified_inbox`; the generated password is kept at `/etc/unified-inbox/db-password` | absent |
| Caddy (official apt repo) | `/etc/caddy/Caddyfile`: `<domain> { reverse_proxy 127.0.0.1:8787 }` | content differs |
| Application code | `/opt/unified-inbox` (`packages/relay`, `packages/shared`, `packages/gui/dist`, root manifests), `bun install --production` | rsync finds a difference |
| Environment | `/etc/unified-inbox/relay.env` (`DATABASE_URL`, `RELAY_PORT`, `RELAY_HOST`, `RELAY_PUBLIC_ORIGIN`, `RELAY_GUI_DIR`) | content differs |
| Service | `unified-inbox-relay.service`, user `unified-inbox`, `Restart=always` | unit differs, or restarted when code or env changed |
| Health | `https://<domain>/api/health` | checked every run |

The relay runs its own database migrations when it starts, so an upgrade needs nothing beyond rerunning the script. DigitalOcean credentials come from `doctl`'s own authentication; the script never asks for a token.

Unverified at build time: no droplet was created and no real host was converged (that costs money and needs a domain). The planner is covered by tests against a fake command runner, and both parameter paths were exercised in `--dry-run`.
