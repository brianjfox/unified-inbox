/** Where Slack sends the browser back; the same string is registered at Slack. */
export function slackRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/oauth/slack/callback`;
}

export type OAuthCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string }
  | { kind: "invalid"; message: string };

/**
 * Parses the query Slack appends on return (FR-19). Slack sends `code` and
 * `state` on approval, or `error` (with an optional `error_description`) when
 * the person cancels or Slack refuses. Anything else is a malformed return.
 */
export function parseOAuthCallback(search: string): OAuthCallback {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const error = q.get("error");
  if (error) {
    const description = q.get("error_description");
    const message = description ? `Slack refused the connection: ${description.replace(/\+/g, " ")} (${error})` : `Slack refused the connection: ${error}`;
    return { kind: "error", message };
  }
  const code = q.get("code");
  const state = q.get("state");
  if (code && state) return { kind: "code", code, state };
  if (code && !state) return { kind: "invalid", message: "Slack returned a code without a state parameter, so the connection cannot be verified." };
  return { kind: "invalid", message: "Slack returned without an authorization code." };
}
