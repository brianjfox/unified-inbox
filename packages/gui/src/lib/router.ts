import { useSyncExternalStore } from "react";

/**
 * A history-based router with three routes (FR-24): the inbox, the
 * Connections screen, and Slack's OAuth return. The relay serves index.html
 * for every unknown path, so deep links to these routes load.
 */
export type Route = { name: "inbox" } | { name: "connections" } | { name: "oauth-slack-callback"; search: string } | { name: "unknown"; path: string };

export function routeFor(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "inbox" };
  if (path === "/connections") return { name: "connections" };
  if (path === "/oauth/slack/callback") return { name: "oauth-slack-callback", search };
  return { name: "unknown", path };
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function snapshot(): string {
  return `${location.pathname}${location.search}`;
}

export function useRoute(): Route {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(current, "http://local");
  return routeFor(url.pathname, url.search);
}
