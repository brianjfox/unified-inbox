import { LogLevel, type Logger as SlackSdkLogger } from "@slack/web-api";
import type { Logger } from "../types.ts";

/**
 * Routes the Slack SDKs' logging (WebClient and SocketModeClient) through the
 * hub's logger so launchd captures one stream. The SDKs log at debug level
 * for most traffic; the hub's own level decides what is written.
 */
export function slackSdkLogger(log: Logger, name: string): SlackSdkLogger {
  let level: LogLevel = LogLevel.DEBUG;
  let scope = name;
  const order: Record<LogLevel, number> = { [LogLevel.DEBUG]: 0, [LogLevel.INFO]: 1, [LogLevel.WARN]: 2, [LogLevel.ERROR]: 3 };
  const line = (parts: unknown[]) => parts.map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  const emit = (lvl: LogLevel, parts: unknown[]) => {
    if (order[lvl] < order[level]) return;
    const msg = `${scope}: ${line(parts)}`;
    if (lvl === LogLevel.ERROR) log.error(msg);
    else if (lvl === LogLevel.WARN) log.warn(msg);
    else if (lvl === LogLevel.INFO) log.info(msg);
    else log.debug(msg);
  };
  return {
    debug: (...msg: unknown[]) => emit(LogLevel.DEBUG, msg),
    info: (...msg: unknown[]) => emit(LogLevel.INFO, msg),
    warn: (...msg: unknown[]) => emit(LogLevel.WARN, msg),
    error: (...msg: unknown[]) => emit(LogLevel.ERROR, msg),
    setLevel: (l: LogLevel) => {
      level = l;
    },
    getLevel: () => level,
    setName: (n: string) => {
      scope = n;
    },
  };
}
