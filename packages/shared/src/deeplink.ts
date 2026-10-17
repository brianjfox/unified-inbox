import type { ConversationState, Service } from "./schema.ts";

export type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

export type DeepLink = {
  /** URL for the installed app, or null when no app exists on this platform. */
  native: string | null;
  /** Browser URL, or null when the service has no web version (iMessage). */
  web: string | null;
  /** Where the link lands when it opens: the message, the conversation, or only the app. */
  depth: "message" | "conversation" | "app";
  /** True when Reply must be shown disabled: no app and no web version here. */
  disabled: boolean;
  /** The destination name for the button: "Reply in Slack". */
  appName: string;
};

export const APP_NAMES: Record<Service, string> = {
  slack: "Slack",
  imessage: "Messages",
  whatsapp: "WhatsApp",
};

/**
 * The deepest link each service supports, per platform. Findings recorded as
 * the resolver (task 12):
 * - Slack: `slack://channel?team=T&id=C&message=ts` reaches the message in the
 *   desktop app; the web client reaches the message via the archives permalink.
 * - WhatsApp: `whatsapp://send?phone=N` opens a one-to-one chat; groups have no
 *   addressable link, so Reply opens the app. Web: web.whatsapp.com/send?phone=N.
 * - iMessage: `imessage://HANDLE` opens the conversation on macOS; no message
 *   anchor exists and there is no web version. Group chats open Messages at the
 *   first handle. Windows and non-Apple phones have no Messages app: disabled.
 */
export function resolveDeepLink(conv: Pick<ConversationState, "service" | "isGroup" | "link" | "messages">, platform: Platform, messageId?: string): DeepLink {
  const appName = APP_NAMES[conv.service];
  switch (conv.service) {
    case "slack": {
      const l = conv.link.slack;
      if (!l) return { native: null, web: null, depth: "app", disabled: false, appName };
      const ts = messageId ?? conv.messages[conv.messages.length - 1]?.id;
      const native = `slack://channel?team=${encodeURIComponent(l.teamId)}&id=${encodeURIComponent(l.channelId)}${ts ? `&message=${encodeURIComponent(ts)}` : ""}`;
      const host = l.teamDomain ? `${l.teamDomain}.slack.com` : "app.slack.com";
      const web = ts && l.teamDomain
        ? `https://${host}/archives/${encodeURIComponent(l.channelId)}/p${ts.replace(".", "")}`
        : `https://app.slack.com/client/${encodeURIComponent(l.teamId)}/${encodeURIComponent(l.channelId)}`;
      return { native, web, depth: ts ? "message" : "conversation", disabled: false, appName };
    }
    case "whatsapp": {
      const l = conv.link.whatsapp;
      const phone = l?.phone ?? (l && !conv.isGroup ? l.jid.split("@")[0] : undefined);
      if (conv.isGroup || !phone) {
        return { native: "whatsapp://", web: "https://web.whatsapp.com/", depth: "app", disabled: false, appName };
      }
      const digits = phone.replace(/\D/g, "");
      return {
        native: `whatsapp://send?phone=${digits}`,
        web: `https://web.whatsapp.com/send?phone=${digits}`,
        depth: "conversation",
        disabled: false,
        appName,
      };
    }
    case "imessage": {
      const hasMessagesApp = platform === "macos" || platform === "ios";
      const handle = conv.link.imessage?.handles[0];
      if (!hasMessagesApp) return { native: null, web: null, depth: "app", disabled: true, appName };
      const native = handle ? `imessage://${encodeURIComponent(handle)}` : "imessage://";
      return { native, web: null, depth: handle ? "conversation" : "app", disabled: false, appName };
    }
  }
}

export function detectPlatform(userAgent: string, tauriPlatform?: string): Platform {
  if (tauriPlatform === "macos" || tauriPlatform === "darwin") return "macos";
  if (tauriPlatform === "windows") return "windows";
  if (tauriPlatform === "linux") return "linux";
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/android/.test(ua)) return "android";
  if (/windows/.test(ua)) return "windows";
  if (/mac os x|macintosh/.test(ua)) return "macos";
  if (/linux/.test(ua)) return "linux";
  return "unknown";
}
