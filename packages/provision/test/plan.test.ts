import { describe, expect, test } from "bun:test";
import { FakeRunner, ok, probeAnswer, rsyncDryRun, startsWith } from "./fake-runner.ts";
import { gatherDropletFacts, gatherHostFacts } from "../src/facts.ts";
import { planDroplet, planHost } from "../src/plan.ts";
import { renderCaddyfile, renderEnv, renderUnit, sha256 } from "../src/render.ts";
import { run } from "../src/run.ts";
import type { CreateOptions, HostOptions } from "../src/types.ts";

const createOpts: CreateOptions = {
  mode: "create",
  name: "unified-inbox-relay",
  region: "nyc3",
  size: "s-1vcpu-1gb",
  image: "ubuntu-24-04-x64",
  sshKey: undefined,
  domain: "inbox.example.net",
  sshUser: "root",
  dryRun: false,
  verbose: false,
};

const hostOpts: HostOptions = { mode: "host", host: "203.0.113.10", domain: "inbox.example.net", sshUser: "root", dryRun: false, verbose: false };
const target = { host: "203.0.113.10", user: "root" };
const repoRoot = "/repo";
const planInput = { domain: "inbox.example.net", target, repoRoot, newPassword: "new-secret" };

const existingDroplet = JSON.stringify([
  { id: 42, name: "unified-inbox-relay", status: "active", networks: { v4: [{ ip_address: "10.0.0.5", type: "private" }, { ip_address: "203.0.113.10", type: "public" }] } },
  { id: 7, name: "other", status: "active", networks: { v4: [] } },
]);

/** Probe output of a host converged for inbox.example.net with password "kept-secret". */
const convergedProbe = {
  bun: "yes",
  postgres: "yes",
  role: "1",
  db: "1",
  caddy: "yes",
  user: "yes",
  caddyfile_sha: sha256(renderCaddyfile("inbox.example.net")),
  env_sha: sha256(renderEnv("inbox.example.net", "kept-secret")),
  unit_sha: sha256(renderUnit()),
  db_password: "kept-secret",
  service_enabled: "enabled",
  service_active: "active",
};

describe("droplet planning", () => {
  test("a fresh --create plans a droplet create with the account's ssh keys", async () => {
    const runner = new FakeRunner([
      startsWith(["doctl", "compute", "droplet", "list"], ok("[]")),
      startsWith(["doctl", "compute", "ssh-key", "list"], ok(JSON.stringify([{ id: 111 }, { id: 222 }]))),
    ]);
    const facts = await gatherDropletFacts(runner, "unified-inbox-relay", true);
    const steps = planDroplet(createOpts, facts);
    expect(steps.map((s) => s.id)).toEqual(["droplet-create"]);
    const argv = steps[0]!.local![0]!.argv;
    expect(argv.slice(0, 5)).toEqual(["doctl", "compute", "droplet", "create", "unified-inbox-relay"]);
    expect(argv).toContain("--wait");
    expect(argv[argv.indexOf("--ssh-keys") + 1]).toBe("111,222");
    expect(argv[argv.indexOf("--region") + 1]).toBe("nyc3");
    expect(argv[argv.indexOf("--size") + 1]).toBe("s-1vcpu-1gb");
  });

  test("--ssh-key overrides the account's keys", async () => {
    const runner = new FakeRunner([startsWith(["doctl", "compute", "droplet", "list"], ok("[]"))]);
    const facts = await gatherDropletFacts(runner, "unified-inbox-relay", false);
    const steps = planDroplet({ ...createOpts, sshKey: "ab:cd" }, facts);
    const argv = steps[0]!.local![0]!.argv;
    expect(argv[argv.indexOf("--ssh-keys") + 1]).toBe("ab:cd");
    expect(runner.calls).toHaveLength(1);
  });

  test("a fresh --create with no ssh key anywhere fails clearly", async () => {
    const runner = new FakeRunner([
      startsWith(["doctl", "compute", "droplet", "list"], ok("[]")),
      startsWith(["doctl", "compute", "ssh-key", "list"], ok("[]")),
    ]);
    const facts = await gatherDropletFacts(runner, "unified-inbox-relay", true);
    expect(() => planDroplet(createOpts, facts)).toThrow(/--ssh-key/);
  });

  test("a second run with the droplet present plans no create", async () => {
    const runner = new FakeRunner([startsWith(["doctl", "compute", "droplet", "list"], ok(existingDroplet))]);
    const facts = await gatherDropletFacts(runner, "unified-inbox-relay", true);
    expect(facts.droplet).toEqual({ id: 42, name: "unified-inbox-relay", status: "active", ip: "203.0.113.10" });
    expect(planDroplet(createOpts, facts)).toEqual([]);
    expect(runner.calls.some((c) => c.argv.includes("ssh-key"))).toBe(false);
  });
});

describe("host planning", () => {
  test("a fresh host plans every install, the files, a start, and the health check", () => {
    const steps = planHost(planInput, {
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
    });
    expect(steps.map((s) => s.id)).toEqual(["bun", "postgres", "database", "caddy", "caddyfile", "user", "code", "env", "unit", "service-start", "health"]);
    const db = steps.find((s) => s.id === "database")!;
    expect(db.files![0]!.path).toBe("/etc/unified-inbox/db-password");
    expect(db.files![0]!.content).toBe("new-secret\n");
    const env = steps.find((s) => s.id === "env")!;
    expect(env.files![0]!.content).toContain("DATABASE_URL=postgres://unified_inbox:new-secret@127.0.0.1:5432/unified_inbox");
    expect(env.files![0]!.content).toContain("RELAY_PUBLIC_ORIGIN=https://inbox.example.net");
    expect(env.files![0]!.mode).toBe("0600");
    const caddy = steps.find((s) => s.id === "caddyfile")!;
    expect(caddy.files![0]!.content).toContain("inbox.example.net {");
    expect(caddy.files![0]!.content).toContain("reverse_proxy 127.0.0.1:8787");
    expect(steps.find((s) => s.id === "health")!.changes).toBe(false);
  });

  test("--host against a converged host plans zero changes and no restart", async () => {
    const runner = new FakeRunner([probeAnswer(convergedProbe), rsyncDryRun("")]);
    const facts = await gatherHostFacts(runner, target, repoRoot);
    expect(facts.codeChanged).toBe(false);
    expect(facts.dbPassword).toBe("kept-secret");
    const steps = planHost(planInput, facts);
    expect(steps.filter((s) => s.changes)).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["health"]);
    expect(JSON.stringify(steps)).not.toContain("systemctl restart");
  });

  test("a code change plans a sync and a restart, nothing else", async () => {
    const runner = new FakeRunner([probeAnswer(convergedProbe), rsyncDryRun(">f.st...... packages/relay/src/server.ts\n")]);
    const facts = await gatherHostFacts(runner, target, repoRoot);
    expect(facts.codeChanged).toBe(true);
    const steps = planHost(planInput, facts);
    expect(steps.map((s) => s.id)).toEqual(["code", "service-restart", "health"]);
    const code = steps.find((s) => s.id === "code")!;
    expect(code.local![0]!.argv[0]).toBe("rsync");
    expect(code.local![0]!.argv).not.toContain("--dry-run");
    expect(code.local![0]!.argv).toContain("/repo/./packages/gui/dist");
    expect(code.remote).toContain("bun install --production");
    expect(steps.find((s) => s.id === "service-restart")!.remote).toBe("systemctl restart unified-inbox-relay");
  });

  test("a changed domain rewrites the Caddyfile and env and restarts", async () => {
    const runner = new FakeRunner([probeAnswer(convergedProbe), rsyncDryRun("")]);
    const facts = await gatherHostFacts(runner, target, repoRoot);
    const steps = planHost({ ...planInput, domain: "mail.example.org" }, facts);
    expect(steps.map((s) => s.id)).toEqual(["caddyfile", "env", "service-restart", "health"]);
    // The kept password is reused; no new one is written.
    expect(steps.find((s) => s.id === "env")!.files![0]!.content).toContain(":kept-secret@");
    expect(steps.some((s) => s.id === "database")).toBe(false);
  });

  test("a stopped service on a converged host is started, not restarted", async () => {
    const runner = new FakeRunner([probeAnswer({ ...convergedProbe, service_active: "inactive" }), rsyncDryRun("")]);
    const facts = await gatherHostFacts(runner, target, repoRoot);
    const steps = planHost(planInput, facts);
    expect(steps.map((s) => s.id)).toEqual(["service-start", "health"]);
    expect(steps[0]!.remote).toBe("systemctl enable --now unified-inbox-relay");
  });
});

describe("whole run through the fake edge", () => {
  const deps = (runner: FakeRunner) => ({ runner, repoRoot: import.meta.dir + "/fixtures/repo", log: () => {}, sleep: async () => {}, newPassword: () => "new-secret" });

  test("--host on a converged host runs only the probe, the rsync dry run, and the health check", async () => {
    const runner = new FakeRunner([probeAnswer(convergedProbe), rsyncDryRun(""), startsWith(["curl"], ok('{"ok":true}'))], { "inbox.example.net": ["203.0.113.10"] });
    const report = await run(hostOpts, deps(runner));
    expect(report.changed).toBe(false);
    expect(runner.calls.map((c) => c.argv[0])).toEqual(["ssh", "rsync", "curl"]);
    const nonProbe = runner.remoteScripts().filter((s) => !s.includes("# unified-inbox probe"));
    expect(nonProbe).toEqual([]);
  });

  test("--create with the droplet present reuses it and converges its IP", async () => {
    const runner = new FakeRunner(
      [
        startsWith(["doctl", "compute", "droplet", "list"], ok(existingDroplet)),
        startsWith(["ssh"], (cmd) => (cmd.input === undefined ? ok() : undefined)),
        probeAnswer(convergedProbe),
        rsyncDryRun(""),
        startsWith(["curl"], ok('{"ok":true}')),
      ],
      { "inbox.example.net": ["203.0.113.10"] },
    );
    const report = await run(createOpts, deps(runner));
    expect(report.droplet?.id).toBe(42);
    expect(report.target).toEqual({ host: "203.0.113.10", user: "root" });
    expect(report.changed).toBe(false);
    expect(runner.calls.some((c) => c.argv.includes("create"))).toBe(false);
  });

  test("--create on a fresh account creates the droplet, waits for ssh, and converges the new host", async () => {
    let listed = 0;
    const created = JSON.stringify([{ id: 99, name: "unified-inbox-relay", status: "active", networks: { v4: [{ ip_address: "198.51.100.7", type: "public" }] } }]);
    let sshProbes = 0;
    const runner = new FakeRunner([
      startsWith(["doctl", "compute", "droplet", "list"], () => ok(listed++ === 0 ? "[]" : created)),
      startsWith(["doctl", "compute", "ssh-key", "list"], ok(JSON.stringify([{ id: 5 }]))),
      startsWith(["doctl", "compute", "droplet", "create"], ok(created)),
      // ssh answers on the second try; the probe then sees a fresh host.
      startsWith(["ssh"], (cmd) => (cmd.input === undefined ? (++sshProbes >= 2 ? ok() : { code: 255, stdout: "", stderr: "Connection refused" }) : undefined)),
      probeAnswer({}),
      rsyncDryRun("cd+++++++++ packages/\n"),
      startsWith(["rsync"], ok()),
      startsWith(["ssh"], ok()),
      startsWith(["curl"], ok('{"ok":true}')),
    ]);
    const report = await run(createOpts, deps(runner));
    expect(report.droplet).toEqual({ id: 99, name: "unified-inbox-relay", status: "active", ip: "198.51.100.7" });
    expect(report.changed).toBe(true);
    expect(report.steps.map((s) => s.id)).toEqual(["bun", "postgres", "database", "caddy", "caddyfile", "user", "code", "env", "unit", "service-start", "health"]);
    expect(sshProbes).toBe(2);
    const scripts = runner.remoteScripts().join("\n");
    expect(scripts).toContain("BUN_INSTALL=/usr/local bash");
    expect(scripts).toContain("CREATE ROLE unified_inbox LOGIN PASSWORD 'new-secret'");
    expect(scripts).toContain("systemctl enable --now unified-inbox-relay");
    const cmd = runner.calls.find((c) => c.argv[3] === "create")!;
    expect(cmd.argv[cmd.argv.indexOf("--ssh-keys") + 1]).toBe("5");
  });
});
