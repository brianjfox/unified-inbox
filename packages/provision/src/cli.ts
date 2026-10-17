import { parseArgs } from "node:util";
import type { Options } from "./types.ts";
import { ProvisionError } from "./types.ts";

export const USAGE = `provision: stand up or update the Unified Inbox relay on DigitalOcean (idempotent; rerun to upgrade)

  provision --create --name <droplet> --region <slug> --size <slug> --domain <fqdn> [--ssh-key <id|fingerprint>] [--image <slug>]
  provision --host <ip-or-hostname> --domain <fqdn> [--ssh-user root]

Options
  --create            Create the droplet with doctl when none has --name; reuse it when one does.
  --name <droplet>    Droplet name (default unified-inbox-relay).
  --region <slug>     DigitalOcean region, e.g. nyc3 (doctl compute region list).
  --size <slug>       Droplet size, e.g. s-1vcpu-1gb (doctl compute size list).
  --image <slug>      Droplet image (default ubuntu-24-04-x64).
  --ssh-key <key>     doctl SSH key id or fingerprint; default: every key in the account.
  --host <host>       Converge an existing host instead of creating one.
  --ssh-user <user>   SSH user on the host (default root; a non-root user needs passwordless sudo).
  --domain <fqdn>     The relay's public name; its A record must point at the host.
  --dry-run           Print every command and file; execute nothing (assumes a fresh target).
  --verbose           Echo each command as it runs.
  -h, --help          This text.

The DigitalOcean token comes from doctl's own authentication (doctl auth init).`;

export function parseCli(argv: string[]): Options | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        create: { type: "boolean", default: false },
        name: { type: "string", default: "unified-inbox-relay" },
        region: { type: "string" },
        size: { type: "string" },
        image: { type: "string", default: "ubuntu-24-04-x64" },
        "ssh-key": { type: "string" },
        host: { type: "string" },
        "ssh-user": { type: "string", default: "root" },
        domain: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new ProvisionError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const v = parsed.values;
  if (v.help) return "help";
  if (v.create && v.host) throw new ProvisionError(`Use either --create or --host, not both.\n\n${USAGE}`);
  if (!v.create && !v.host) throw new ProvisionError(`One of --create or --host is required.\n\n${USAGE}`);
  if (!v.domain) throw new ProvisionError(`--domain is required: the name the relay is reached at (https://<domain>).\n\n${USAGE}`);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.domain)) throw new ProvisionError(`--domain must be a hostname such as inbox.example.net, got ${v.domain}`);
  const common = { domain: v.domain.toLowerCase(), sshUser: v["ssh-user"], dryRun: v["dry-run"], verbose: v.verbose };
  if (v.create) {
    if (!v.region || !v.size) throw new ProvisionError(`--create needs --region and --size (doctl compute region list; doctl compute size list).\n\n${USAGE}`);
    return { mode: "create", name: v.name, region: v.region, size: v.size, image: v.image, sshKey: v["ssh-key"], ...common };
  }
  return { mode: "host", host: v.host!, ...common };
}
