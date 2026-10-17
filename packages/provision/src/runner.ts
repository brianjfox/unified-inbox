import { promises as dns } from "node:dns";
import type { Command, CommandResult, CommandRunner } from "./types.ts";
import { shellQuote } from "./remote.ts";

export function formatCommand(cmd: Command): string {
  return cmd.argv.map(shellQuote).join(" ");
}

/** Spawns the real processes. `verbose` echoes each command before it runs. */
export class ProcessRunner implements CommandRunner {
  constructor(private readonly verbose: boolean, private readonly log: (line: string) => void = console.error) {}

  async run(cmd: Command): Promise<CommandResult> {
    if (this.verbose) this.log(`$ ${formatCommand(cmd)}`);
    const proc = Bun.spawn(cmd.argv, {
      stdin: cmd.input === undefined ? "ignore" : new Response(cmd.input),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (this.verbose && stderr.trim()) this.log(stderr.trimEnd());
    return { code, stdout, stderr };
  }

  async lookup(hostname: string): Promise<string[]> {
    try {
      return await dns.resolve4(hostname);
    } catch {
      return [];
    }
  }
}

/** Prints what would run and executes nothing. Every command "succeeds" with empty output. */
export class DryRunRunner implements CommandRunner {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async run(cmd: Command): Promise<CommandResult> {
    this.log(`$ ${formatCommand(cmd)}`);
    if (cmd.input !== undefined) {
      this.log(cmd.input.trimEnd().split("\n").map((l) => `    | ${l}`).join("\n"));
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async lookup(): Promise<string[]> {
    return [];
  }
}
