import type { Logger } from "./connectors/types.ts";

/** Line-oriented structured logs: launchd captures stdout/stderr to the log files the README names. */
export function createLogger(scope: string, level: "debug" | "info" | "warn" | "error" = (process.env.HUB_LOG_LEVEL as never) ?? "info"): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const emit = (lvl: keyof typeof order, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}${data ? " " + JSON.stringify(data) : ""}`;
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}
