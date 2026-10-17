import type { Command, CommandResult, CommandRunner } from "../src/types.ts";

export type Answer = (cmd: Command) => CommandResult | undefined;

/**
 * The network edge, faked: answers commands from the handlers given, records
 * every call, and fails loudly on a command nobody expected.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: Command[] = [];
  constructor(
    private readonly answers: Answer[],
    private readonly addresses: Record<string, string[]> = {},
  ) {}

  async run(cmd: Command): Promise<CommandResult> {
    this.calls.push(cmd);
    for (const a of this.answers) {
      const r = a(cmd);
      if (r) return r;
    }
    throw new Error(`FakeRunner: unexpected command ${cmd.argv.join(" ")}${cmd.input ? `\n${cmd.input}` : ""}`);
  }

  async lookup(hostname: string): Promise<string[]> {
    return this.addresses[hostname] ?? [];
  }

  /** Every remote script that was run (ssh with stdin). */
  remoteScripts(): string[] {
    return this.calls.filter((c) => c.argv[0] === "ssh" && c.input !== undefined).map((c) => c.input!);
  }
}

export const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

export const startsWith = (prefix: string[], result: CommandResult | ((cmd: Command) => CommandResult | undefined)): Answer => (cmd) =>
  prefix.every((p, i) => cmd.argv[i] === p) ? (typeof result === "function" ? result(cmd) : result) : undefined;

export const probeAnswer = (lines: Record<string, string>): Answer => (cmd) =>
  cmd.argv[0] === "ssh" && cmd.input?.includes("# unified-inbox probe")
    ? ok(Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")
    : undefined;

export const rsyncDryRun = (itemized: string): Answer => (cmd) => (cmd.argv[0] === "rsync" && cmd.argv.includes("--dry-run") ? ok(itemized) : undefined);
