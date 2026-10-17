import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Service credentials and the hub's own keys live in the macOS login keychain,
 * never in files (NFR-3, AC-19). This wraps the `security` tool that ships
 * with macOS; one generic-password item per key under one service name.
 */
export type Keychain = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export class KeychainError extends Error {}

export function createMacKeychain(serviceName: string): Keychain {
  if (process.platform !== "darwin") {
    throw new KeychainError(`The connector hub stores credentials in the macOS keychain and runs only on macOS (this is ${process.platform}).`);
  }
  return {
    async get(key) {
      try {
        const { stdout } = await run("security", ["find-generic-password", "-s", serviceName, "-a", key, "-w"]);
        return stdout.replace(/\n$/, "");
      } catch (err) {
        const e = err as { code?: number; stderr?: string };
        if (e.code === 44 || /could not be found/.test(e.stderr ?? "")) return null;
        throw new KeychainError(`keychain read failed for ${key}: ${e.stderr ?? String(err)}`);
      }
    },
    async set(key, value) {
      try {
        await run("security", ["add-generic-password", "-U", "-s", serviceName, "-a", key, "-w", value]);
      } catch (err) {
        const e = err as { stderr?: string };
        throw new KeychainError(`keychain write failed for ${key}: ${e.stderr ?? String(err)}`);
      }
    },
    async delete(key) {
      try {
        await run("security", ["delete-generic-password", "-s", serviceName, "-a", key]);
      } catch (err) {
        const e = err as { code?: number; stderr?: string };
        if (e.code === 44 || /could not be found/.test(e.stderr ?? "")) return;
        throw new KeychainError(`keychain delete failed for ${key}: ${e.stderr ?? String(err)}`);
      }
    },
  };
}
