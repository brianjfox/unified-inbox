import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseCli } from "../src/cli.ts";

const script = resolve(import.meta.dir, "../provision.ts");

async function cli(...args: string[]) {
  const proc = Bun.spawn([script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: process.env.PATH ?? "" } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("argument parsing", () => {
  test("--create needs region, size, and domain", () => {
    expect(() => parseCli(["--create"])).toThrow(/--domain is required/);
    expect(() => parseCli(["--create", "--domain", "inbox.example.net"])).toThrow(/--region and --size/);
    expect(parseCli(["--create", "--domain", "Inbox.Example.net", "--region", "nyc3", "--size", "s-1vcpu-1gb"])).toMatchObject({ mode: "create", domain: "inbox.example.net", name: "unified-inbox-relay", image: "ubuntu-24-04-x64" });
  });
  test("--host and --create exclude each other", () => {
    expect(() => parseCli(["--host", "1.2.3.4", "--create", "--domain", "a.example.net"])).toThrow(/either --create or --host/);
    expect(() => parseCli(["--domain", "a.example.net"])).toThrow(/One of --create or --host/);
    expect(() => parseCli(["--host", "1.2.3.4", "--domain", "a.example.net", "--bogus"])).toThrow(/bogus/);
  });
});

describe("the real CLI in --dry-run (no network)", () => {
  test("--create prints the droplet create and the whole converge plan", async () => {
    const r = await cli("--create", "--name", "unified-inbox-relay", "--region", "nyc3", "--size", "s-1vcpu-1gb", "--domain", "inbox.example.net", "--ssh-key", "12345", "--dry-run");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toContain("$ doctl compute droplet create unified-inbox-relay --region nyc3 --size s-1vcpu-1gb --image ubuntu-24-04-x64 --ssh-keys 12345");
    expect(r.stdout).toContain("ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 'root@<droplet-ip>' -- 'bash -s'");
    expect(r.stdout).toContain("would write /etc/caddy/Caddyfile");
    expect(r.stdout).toContain("would write /etc/unified-inbox/relay.env");
    expect(r.stdout).toContain("would write /etc/systemd/system/unified-inbox-relay.service");
    expect(r.stdout).toContain("$ curl -fsS --max-time 15 https://inbox.example.net/api/health");
  });

  test("--host prints the converge plan for the host", async () => {
    const r = await cli("--host", "203.0.113.10", "--domain", "inbox.example.net", "--ssh-user", "ubuntu", "--dry-run");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("doctl");
    expect(r.stdout).toContain("ubuntu@203.0.113.10 -- 'sudo -n bash -s'");
    expect(r.stdout).toContain("--rsync-path 'sudo rsync'");
    expect(r.stdout).toContain("RELAY_PUBLIC_ORIGIN=https://inbox.example.net");
  });

  test("a missing --domain exits 2 with the usage", async () => {
    const r = await cli("--host", "203.0.113.10");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--domain is required");
    expect(r.stderr).toContain("provision --host <ip-or-hostname>");
  });

  test("--help exits 0", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provision --create");
  });
});
