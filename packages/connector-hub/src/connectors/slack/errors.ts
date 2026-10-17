import { ErrorCode } from "@slack/web-api";
import { isRecord } from "./events.ts";

/**
 * `@slack/web-api` rejects every `ok: false` response with a platform error
 * whose `data.error` is Slack's own error string ("invalid_code",
 * "missing_scope", ...). That string is what the Connections screen shows,
 * so it is pulled out here; other failures keep their message.
 */
export function slackErrorMessage(err: unknown): string {
  const platform = slackPlatformErrorCode(err);
  if (platform) return platform;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Slack's `error` string when `err` is a platform error, otherwise null. */
export function slackPlatformErrorCode(err: unknown): string | null {
  if (!isRecord(err)) return null;
  if (err.code !== ErrorCode.PlatformError) return null;
  if (!isRecord(err.data) || typeof err.data.error !== "string") return null;
  return err.data.error;
}
