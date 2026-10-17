/**
 * Slack message timestamps are strings of the form "<unix seconds>.<sequence>".
 * They identify a message within a channel and order messages in time.
 */
export function slackTsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

/** A Slack ts string for `days` days before `now`, for `conversations.history`'s `oldest`. */
export function slackTsDaysAgo(days: number, now: number = Date.now()): string {
  return `${Math.floor((now - days * 86_400_000) / 1000)}.000000`;
}

/** Numeric comparison of two Slack ts strings (negative when `a` is older). */
export function compareSlackTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

export type SlackUserLike = {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

/** The name a person shows under in Slack: display name, then real name, then handle, then the id. */
export function displayNameOf(user: SlackUserLike, fallbackId: string): string {
  const candidates = [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return fallbackId;
}

/**
 * Turns Slack's message markup into readable text: `<@U123>` becomes `@Name`
 * when the name is known (the raw mention stays otherwise), channel links,
 * special mentions and URL labels are unwrapped, and HTML entities are decoded.
 */
export function renderSlackText(text: string, nameFor: (userId: string) => string | undefined): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (whole: string, id: string, label: string | undefined) => {
      const name = nameFor(id) ?? (label && label.length > 0 ? label : undefined);
      return name ? `@${name}` : whole;
    })
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]*)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The workspace subdomain of a Slack URL such as https://acme.slack.com/, or null when it has none. */
export function teamDomainFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const [sub, ...rest] = host.split(".");
    return sub && rest.length >= 2 ? sub : null;
  } catch {
    return null;
  }
}
