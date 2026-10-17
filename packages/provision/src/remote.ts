import type { Command, RemoteFile, SshTarget } from "./types.ts";
import { PATHS, SYNC_EXCLUDES, SYNC_PATHS } from "./render.ts";

export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];

/** `ssh user@host -- <shell>` where the shell runs the script fed on stdin as root. */
export function sshCommand(target: SshTarget, script: string): Command {
  const shell = target.user === "root" ? "bash -s" : "sudo -n bash -s";
  return { argv: ["ssh", ...SSH_OPTIONS, `${target.user}@${target.host}`, "--", shell], input: script };
}

/** A probe that only tests reachability. */
export function sshReachableCommand(target: SshTarget): Command {
  return { argv: ["ssh", ...SSH_OPTIONS, `${target.user}@${target.host}`, "--", "true"] };
}

/**
 * rsync of the application paths to /opt/unified-inbox. `--relative` keeps
 * the repository layout; `--delete` removes files that left the repository.
 * With `dryRun`, rsync itemizes what it would change and transfers nothing.
 */
export function rsyncCommand(repoRoot: string, target: SshTarget, dryRun: boolean): Command {
  const rsyncPath = target.user === "root" ? [] : ["--rsync-path", "sudo rsync"];
  const argv = [
    "rsync",
    "-rltzO",
    "--delete",
    "--relative",
    "--chmod=D755,F644",
    ...(dryRun ? ["--dry-run", "--itemize-changes"] : []),
    ...SYNC_EXCLUDES.flatMap((e) => ["--exclude", e]),
    "-e",
    `ssh ${SSH_OPTIONS.join(" ")}`,
    ...rsyncPath,
    ...SYNC_PATHS.map((p) => `${repoRoot}/./${p}`),
    `${target.user}@${target.host}:${PATHS.app}/`,
  ];
  return { argv };
}

/** True when rsync's itemized dry-run output lists anything to transfer or delete. */
export function rsyncReportsChanges(result: { code: number; stdout: string }): boolean {
  if (result.code !== 0) return true;
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .some((l) => /^(\*deleting|[<>ch.][fdLDS])/.test(l) && !/^\.[fdLDS] {9}/.test(l));
}

/** Shell lines that write a file atomically with the given mode and owner. */
export function writeFileScript(file: RemoteFile): string {
  const b64 = Buffer.from(file.content, "utf8").toString("base64");
  const dir = file.path.substring(0, file.path.lastIndexOf("/"));
  const owner = file.owner ?? "root:root";
  return [
    `install -d -m 0755 ${shellQuote(dir)}`,
    `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(file.path + ".tmp")}`,
    `chmod ${file.mode} ${shellQuote(file.path + ".tmp")}`,
    `chown ${owner} ${shellQuote(file.path + ".tmp")}`,
    `mv -f ${shellQuote(file.path + ".tmp")} ${shellQuote(file.path)}`,
  ].join("\n");
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The complete script a step runs on the host: strict mode, file writes, then the step's own script. */
export function remoteScript(files: RemoteFile[] | undefined, script: string | undefined): string {
  return [
    `set -euo pipefail`,
    `export DEBIAN_FRONTEND=noninteractive`,
    `export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...(files ?? []).map(writeFileScript),
    ...(script ? [script] : []),
    ``,
  ].join("\n");
}
