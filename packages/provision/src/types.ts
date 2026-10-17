/** A command run on this machine: doctl, ssh, rsync, curl. `input` is fed to stdin. */
export type Command = { argv: string[]; input?: string };

export type CommandResult = { code: number; stdout: string; stderr: string };

/**
 * The network edge. The real runner spawns processes; tests substitute a fake
 * that answers from fixtures, so the planner and executor run unchanged.
 */
export interface CommandRunner {
  run(cmd: Command): Promise<CommandResult>;
  /** IPv4 addresses a hostname resolves to; [] when it does not resolve. */
  lookup(hostname: string): Promise<string[]>;
}

export type RemoteFile = {
  path: string;
  content: string;
  /** Octal mode string such as "0600". */
  mode: string;
  /** owner:group; defaults to root:root. */
  owner?: string;
};

/**
 * One unit of the plan. Steps are data: the planner returns them and the
 * executor runs them, so tests inspect plans without touching a host.
 */
export type Step = {
  id: string;
  title: string;
  /** True when the step changes the target. Probes and health checks are false. */
  changes: boolean;
  /** Commands run on this machine, in order. */
  local?: Command[];
  /** Files written on the host (before `remote` runs). */
  files?: RemoteFile[];
  /** A bash script run on the host as root. */
  remote?: string;
  /** Retry the step's local commands until one succeeds. */
  retry?: { attempts: number; delayMs: number };
};

export type SshTarget = { host: string; user: string };

export type CommonOptions = {
  domain: string;
  sshUser: string;
  dryRun: boolean;
  verbose: boolean;
};

export type CreateOptions = CommonOptions & {
  mode: "create";
  name: string;
  region: string;
  size: string;
  image: string;
  sshKey: string | undefined;
};

export type HostOptions = CommonOptions & {
  mode: "host";
  host: string;
};

export type Options = CreateOptions | HostOptions;

export type Droplet = { id: number; name: string; ip: string | null; status: string };

export type DropletFacts = {
  /** The droplet with the requested name, when one exists. */
  droplet: Droplet | null;
  /** SSH key ids in the DigitalOcean account, used when --ssh-key is not given. */
  sshKeyIds: string[];
};

export type HostFacts = {
  bun: boolean;
  postgres: boolean;
  role: boolean;
  db: boolean;
  caddy: boolean;
  user: boolean;
  caddyfileSha: string | null;
  envSha: string | null;
  unitSha: string | null;
  /** The database password already kept on the host, when it exists. */
  dbPassword: string | null;
  serviceEnabled: boolean;
  serviceActive: boolean;
  /** True when rsync would transfer or delete anything. */
  codeChanged: boolean;
};

/** What the planner assumes about a target it has not probed (dry run, fresh droplet). */
export const FRESH_HOST: HostFacts = {
  bun: false,
  postgres: false,
  role: false,
  db: false,
  caddy: false,
  user: false,
  caddyfileSha: null,
  envSha: null,
  unitSha: null,
  dbPassword: null,
  serviceEnabled: false,
  serviceActive: false,
  codeChanged: true,
};

export class ProvisionError extends Error {}
