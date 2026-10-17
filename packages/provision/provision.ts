#!/usr/bin/env bun
/**
 * Idempotent provisioning of the Unified Inbox relay on DigitalOcean (ADR-7,
 * AC-P4). Run with --help for usage. Rerunning is the upgrade path: every
 * step converges and a converged host sees no change.
 */
import { resolve } from "node:path";
import { parseCli, USAGE } from "./src/cli.ts";
import { run } from "./src/run.ts";
import { DryRunRunner, ProcessRunner } from "./src/runner.ts";
import { ProvisionError } from "./src/types.ts";

async function main(argv: string[]): Promise<number> {
  const opts = parseCli(argv);
  if (opts === "help") {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = resolve(import.meta.dir, "../..");
  const log = (line: string) => console.log(line);
  const runner = opts.dryRun ? new DryRunRunner(log) : new ProcessRunner(opts.verbose, (l) => console.error(l));
  await run(opts, { runner, repoRoot, log, sleep: (ms) => Bun.sleep(ms) });
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof ProvisionError) {
      console.error(`provision: ${err.message}`);
      process.exit(2);
    }
    console.error("provision: unexpected failure", err);
    process.exit(1);
  });
