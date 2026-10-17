import type { Command, CommandRunner, SshTarget, Step } from "./types.ts";
import { ProvisionError } from "./types.ts";
import { remoteScript, sshCommand } from "./remote.ts";
import { formatCommand } from "./runner.ts";

export type Executor = {
  runner: CommandRunner;
  target: SshTarget | null;
  dryRun: boolean;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

async function runLocal(ex: Executor, step: Step, cmd: Command): Promise<string> {
  const result = await ex.runner.run(cmd);
  if (result.code !== 0) {
    throw new ProvisionError(`Step "${step.title}" failed: ${formatCommand(cmd)} exited ${result.code}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Runs one step: its local commands (with retries when asked), then its files
 * and script on the host as one ssh session. Returns the last local stdout,
 * which the orchestrator reads for doctl's JSON.
 */
export async function executeStep(ex: Executor, step: Step): Promise<string> {
  ex.log(`==> ${step.title}`);
  let lastStdout = "";
  for (const cmd of step.local ?? []) {
    if (step.retry && !ex.dryRun) {
      let attempt = 0;
      for (;;) {
        attempt++;
        const result = await ex.runner.run(cmd);
        if (result.code === 0) {
          lastStdout = result.stdout;
          break;
        }
        if (attempt >= step.retry.attempts) {
          throw new ProvisionError(`Step "${step.title}" failed after ${attempt} attempts: ${formatCommand(cmd)}\n${result.stderr || result.stdout}`);
        }
        ex.log(`    not yet (${result.stderr.trim().split("\n")[0] ?? ""}); retrying in ${step.retry.delayMs / 1000}s (${attempt}/${step.retry.attempts})`);
        await ex.sleep(step.retry.delayMs);
      }
    } else {
      lastStdout = await runLocal(ex, step, cmd);
    }
  }
  if (step.files || step.remote) {
    if (!ex.target) throw new ProvisionError(`Step "${step.title}" needs a host but none is known yet.`);
    if (ex.dryRun) {
      for (const f of step.files ?? []) {
        ex.log(`    would write ${f.path} (mode ${f.mode}):`);
        ex.log(f.content.trimEnd().split("\n").map((l) => `    | ${l}`).join("\n"));
      }
    }
    const cmd = sshCommand(ex.target, remoteScript(step.files, step.remote));
    await runLocal(ex, step, cmd);
  }
  return lastStdout;
}

export async function executeAll(ex: Executor, steps: Step[]): Promise<void> {
  for (const step of steps) await executeStep(ex, step);
}
