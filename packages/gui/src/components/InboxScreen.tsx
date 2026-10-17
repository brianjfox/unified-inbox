import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, EmptyState, Input, Skeleton } from "@corbits/react-ui";
import type { ConversationState } from "@inbox/shared/schema";
import { resolveDeepLink } from "@inbox/shared/deeplink";
import { useAppState, store, type AppState } from "../lib/store.ts";
import { session, HubOfflineError } from "../lib/session.ts";
import { navigate } from "../lib/router.ts";
import { applyFilter, FILTER_LABELS, FILTERS, unreadCounts, type Filter } from "../lib/unread.ts";
import { conversationSlug } from "../lib/slug.ts";
import { clockTime, messageTime, rowTime } from "../lib/time.ts";
import { openDeepLink } from "../lib/platform.ts";
import type { ConversationRow } from "../db/cache.ts";
import { Chip, Dot } from "./bits.tsx";

type Mode = "normal" | "loading" | "empty" | "offline";

/**
 * The design names the loading, empty and offline screens' controls with a
 * prefix (`loading-inbox-search`, `offline-button-mark-all-read`); the
 * normal inbox has none.
 */
function prefixFor(mode: Mode): string {
  return mode === "normal" ? "" : `${mode}-`;
}

function displayName(row: Pick<ConversationRow, "name" | "isGroup">): string {
  return row.isGroup ? `${row.name} · group` : row.name;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HubOfflineError) return;
    store.set({ actionError: errText(err) });
  }
}

function replyHint(service: ConversationState["service"], appName: string, offline: boolean): string {
  if (offline) return `Reply still works — it opens the ${appName} app directly, no hub needed.`;
  switch (service) {
    case "slack":
      return "Reply opens the Slack app at this message. If Slack isn't installed here, it opens Slack in the browser instead.";
    case "imessage":
      return "Opens Messages at this conversation (iMessage deep links don't reach a single message). On Windows and on non-Apple phones, where iMessage has no app, Reply is shown disabled.";
    case "whatsapp":
      return "Opens the WhatsApp app at this chat; falls back to WhatsApp Web if the app isn't installed here.";
  }
}

function paneSubline(state: ConversationState, app: AppState, offline: boolean): string {
  if (offline) return "Read-only while the hub is offline — read state will sync back once it reconnects.";
  switch (state.service) {
    case "slack":
      return `${state.workspaceName ? `${state.workspaceName} workspace` : "Slack"} · marked read here and in Slack when opened`;
    case "imessage":
      return app.hubStatus?.imessage.readBack === "per-conversation"
        ? "iMessage via your Mac hub · read-back is per conversation, as fine as iMessage allows"
        : "iMessage via your Mac hub · marked read here and on your other devices; Messages keeps its own badge";
    case "whatsapp":
      return `${state.isGroup ? "WhatsApp group" : "WhatsApp"} · marked read here and in WhatsApp when opened`;
  }
}

export function InboxScreen() {
  const app = useAppState();
  const [filter, setFilter] = useState<Filter>("all");
  const [showRead, setShowRead] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const ready = app.phase.kind === "ready";
  const loading = !ready || !app.firstSyncDone;
  const offline = ready && app.hubOffline;
  const counts = useMemo(() => unreadCounts(app.conversations), [app.conversations]);
  const searching = app.searchText.trim().length > 0;
  const baseRows = searching && app.searchResults ? app.searchResults : app.conversations;
  const rows = useMemo(() => applyFilter(baseRows, filter), [baseRows, filter]);

  // A new unread arrival returns the inbox from "show read" to the normal list (IR-8).
  useEffect(() => {
    if (counts.all > 0 && showRead) setShowRead(false);
  }, [counts.all, showRead]);

  const empty = ready && app.firstSyncDone && !offline && counts.all === 0 && !showRead && !searching && app.selectedKey === null;
  const mode: Mode = loading ? "loading" : offline ? "offline" : empty ? "empty" : "normal";
  const tid = useCallback((name: string) => `${prefixFor(mode)}${name}`, [mode]);

  const selectedRow = app.selectedKey ? (app.conversations.find((r) => r.key === app.selectedKey) ?? null) : null;
  const selectedState = app.selectedState;

  const reply = useCallback(
    (state: ConversationState) => {
      const last = state.messages[state.messages.length - 1];
      const link = resolveDeepLink(state, app.platform, last?.id);
      if (link.disabled) return;
      void openDeepLink(link);
    },
    [app.platform],
  );

  const toggleUnread = useCallback(
    (row: ConversationRow) => {
      if (offline) return;
      void runAction(() => session.setUnread([row.key], !row.unread));
    },
    [offline],
  );

  const openRow = useCallback((key: string) => {
    setCursorKey(key);
    void runAction(() => session.openConversation(key));
  }, []);

  // Keyboard (IR-10): Up/Down move, Enter opens, R replies, U toggles unread, / focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (rows.length === 0) return;
        e.preventDefault();
        const current = cursorKey ?? app.selectedKey;
        const idx = rows.findIndex((r) => r.key === current);
        const next = idx === -1 ? 0 : e.key === "ArrowDown" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
        const row = rows[next];
        if (!row) return;
        setCursorKey(row.key);
        const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"] .conv-main`);
        el?.focus();
        return;
      }
      if (e.key === "Enter") {
        if (target && listRef.current?.contains(target)) return; // the focused row button opens itself
        if (cursorKey) openRow(cursorKey);
        return;
      }
      if (e.key === "r" || e.key === "R") {
        if (selectedState) reply(selectedState);
        return;
      }
      if (e.key === "u" || e.key === "U") {
        const key = app.selectedKey ?? cursorKey;
        const row = key ? rows.find((r) => r.key === key) ?? app.conversations.find((r) => r.key === key) : undefined;
        if (row) toggleUnread(row);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursorKey, app.selectedKey, app.conversations, selectedState, reply, toggleUnread, openRow]);

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      void session.setSearch("");
      e.currentTarget.blur();
    }
  };

  const loadingStatus = (() => {
    if (app.phase.kind === "unreachable") return { tone: "err" as const, text: "Can't reach the sync server", extra: null };
    if (app.phase.kind === "pending-approval") return { tone: "warn" as const, text: "Connecting to hub…", extra: "This device is waiting for approval from another device." };
    return { tone: "warn" as const, text: "Connecting to hub…", extra: null };
  })();

  const servicesOk = !!app.hubStatus && app.hubStatus.imessage.state === "connected" && app.hubStatus.slack.state === "connected" && app.hubStatus.whatsapp.state === "connected";
  const screenTestId = mode === "normal" ? "screen-inbox" : mode === "loading" ? "screen-inbox-loading" : mode === "empty" ? "screen-inbox-empty" : "screen-hub-offline";
  const screenLabel = mode === "normal" ? "Inbox" : mode === "loading" ? "Inbox, loading" : mode === "empty" ? "Inbox, all caught up" : "Inbox, hub unreachable";
  const navFilters: readonly Filter[] = mode === "loading" || mode === "empty" ? ["all", "unread"] : FILTERS;
  const hasOpen = mode !== "empty" && app.selectedKey !== null;

  return (
    <section className="screen" data-testid={screenTestId} aria-label={screenLabel}>
      <div className={`app${hasOpen ? " has-open" : ""}`}>
        <aside className="sidebar" data-testid="inbox-sidebar" aria-label="Filters and status">
          <div className="brand" data-testid="app-brand">
            Inbox
          </div>
          <nav aria-label="Filter by service">
            {navFilters.map((f) => {
              const count = mode === "loading" ? null : counts[f];
              return (
                <button key={f} type="button" className="navlink" aria-current={filter === f ? "true" : undefined} data-testid={tid(`nav-filter-${f}`)} onClick={() => setFilter(f)}>
                  {FILTER_LABELS[f]}
                  <span className={`count${count === null || count === 0 ? " zero" : ""}`} aria-label={count === null ? "count unknown" : `${count} unread`}>
                    {count === null ? "…" : count}
                  </span>
                </button>
              );
            })}
            {ready ? (
              <a className="navlink" href="/connections" data-testid="nav-connections" onClick={(e) => (e.preventDefault(), navigate("/connections"))}>
                Connections
              </a>
            ) : null}
          </nav>
          {mode === "loading" ? (
            <div className="sidefoot" data-testid="loading-sync-status">
              <span className="dotline">
                <Dot tone={loadingStatus.tone} />
                {loadingStatus.text}
              </span>
              {loadingStatus.extra ? <span className="loading-extra">{loadingStatus.extra}</span> : null}
            </div>
          ) : mode === "offline" ? (
            <div className="sidefoot" data-testid="offline-sync-status">
              <span className="dotline">
                <Dot tone="err" />
                Mac hub unreachable
              </span>
              <span className="dotline">
                <Dot tone="err" />
                All three services stale
              </span>
              <span data-testid="offline-last-synced">{app.lastSyncedAt ? `Last synced ${clockTime(app.lastSyncedAt)}` : "Not synced yet"}</span>
            </div>
          ) : (
            <div className="sidefoot" data-testid={mode === "empty" ? "empty-sync-status" : "sidebar-sync-status"}>
              <span className="dotline">
                <Dot tone="ok" />
                Mac hub online
              </span>
              <span className="dotline">
                <Dot tone={servicesOk ? "ok" : "warn"} />
                iMessage · Slack · WhatsApp
              </span>
              <span data-testid="sidebar-last-synced">{app.lastSyncedAt ? `Synced ${clockTime(app.lastSyncedAt)}` : "Not synced yet"}</span>
            </div>
          )}
        </aside>

        <div className="main">
          {mode === "offline" ? (
            <div className="banner error" data-testid="banner-hub-offline" role="alert">
              <strong>Mac hub unreachable since {app.hubOfflineSince ? clockTime(app.hubOfflineSince) : "now"}.</strong>
              <span>You're seeing the inbox as of then. New messages and read-state changes will catch up when the hub is back; it retries on its own.</span>
              <Button type="button" variant="outline" className="btn" data-testid="button-retry-hub" onClick={() => void session.retryHub()}>
                Check again
              </Button>
            </div>
          ) : null}
          {app.actionError ? (
            <div className="banner error" data-testid="banner-action-error" role="alert">
              <span>{app.actionError}</span>
              <Button type="button" variant="outline" className="btn" onClick={() => session.clearActionError()}>
                Dismiss
              </Button>
            </div>
          ) : null}

          <div className="topbar" data-testid={mode === "normal" ? "inbox-topbar" : undefined}>
            <div className="searchwrap">
              <label htmlFor="inbox-search">Search</label>
              <Input
                id="inbox-search"
                ref={searchRef}
                type="search"
                data-testid={tid("inbox-search")}
                placeholder={mode === "loading" ? undefined : "Names and messages"}
                disabled={mode === "loading"}
                value={app.searchText}
                onChange={(e) => void session.setSearch(e.target.value)}
                onKeyDown={onSearchKey}
                autoComplete="off"
              />
            </div>
            {mode === "empty" ? null : (
              <Button
                type="button"
                variant="outline"
                className="btn"
                data-testid={tid("button-mark-all-read")}
                disabled={mode === "loading" || mode === "offline" || counts.all === 0}
                title={mode === "offline" ? "Unavailable while the hub is offline" : undefined}
                onClick={() => void runAction(() => session.markAllRead())}
              >
                Mark all read
              </Button>
            )}
          </div>

          {mode === "empty" ? (
            <div className="empty" data-testid="empty-state">
              <EmptyState
                className="empty-body"
                icon={<span className="glyph">✓</span>}
                title="All caught up"
                description="Nothing unread on iMessage, Slack, or WhatsApp. You don't need to open the other apps — if something were waiting, it would be here."
                action={
                  <p data-testid="empty-state-filter-hint" className="small">
                    Showing unread only.{" "}
                    <Button type="button" variant="link" className="iconbtn inline" data-testid="button-show-read" onClick={() => setShowRead(true)}>
                      Show read conversations
                    </Button>
                  </p>
                }
              />
            </div>
          ) : mode === "loading" ? (
            <div className="split">
              <div className="convlist" data-testid="loading-skeleton-list" role="status" aria-label="Loading conversations">
                {[
                  [55, 85],
                  [40, 75],
                  [62, 80],
                  [48, 70],
                ].map(([a, b], i) => (
                  <div className="skel-row" key={i}>
                    <Skeleton className="skel" style={{ height: 14, width: `${a}%` }} />
                    <Skeleton className="skel" style={{ height: 12, width: `${b}%` }} />
                  </div>
                ))}
              </div>
              <div className="pane">
                <div className="pane-placeholder" data-testid="loading-pane-placeholder">
                  Syncing your inbox…
                </div>
              </div>
            </div>
          ) : (
            <div className="split">
              <ul className="convlist" ref={listRef} data-testid={tid("conversation-list")} aria-label={mode === "offline" ? "Stale conversations" : "Conversations, newest first"}>
                {rows.length === 0 ? (
                  <li className="list-note">{searching ? `No conversations match "${app.searchText.trim()}".` : filter === "unread" ? "Nothing unread." : "No conversations here yet."}</li>
                ) : null}
                {rows.map((row) => {
                  const slug = conversationSlug(row.name, row.service, row.conversationId);
                  const selected = row.key === app.selectedKey;
                  return (
                    <li
                      key={row.key}
                      data-key={row.key}
                      className={`conv${row.unread ? " unread" : ""}${selected ? " selected" : ""}${mode === "offline" ? " stale" : ""}`}
                      data-testid={tid(`conversation-${slug}`)}
                    >
                      <button type="button" className="conv-main" aria-current={selected ? "true" : undefined} aria-label={`${displayName(row)}${row.unread ? ", unread" : ""}`} onClick={() => openRow(row.key)}>
                        <span className="conv-top">
                          <Chip service={row.service} />
                          <span className="conv-name">{displayName(row)}</span>
                          <span className="conv-time">{rowTime(row.lastMessageAt)}</span>
                        </span>
                        <span className="conv-preview">{row.preview}</span>
                      </button>
                      <span className="conv-act">
                        <Button
                          type="button"
                          variant="ghost"
                          className="iconbtn"
                          data-testid={tid(`button-row-mark-${row.unread ? "read" : "unread"}-${slug}`)}
                          aria-label={mode === "offline" ? `Mark ${row.unread ? "read" : "unread"} unavailable while hub is offline` : `Mark ${displayName(row)} ${row.unread ? "read" : "unread"}`}
                          disabled={mode === "offline"}
                          onClick={() => toggleUnread(row)}
                        >
                          {row.unread ? "Read" : "Unread"}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>

              <div className="pane" data-testid="reading-pane" aria-label="Open conversation">
                <Button type="button" variant="outline" className="pane-back" data-testid="button-back-to-list" onClick={() => session.closeConversation()}>
                  ← All conversations
                </Button>
                {selectedRow && selectedState ? (
                  <ReadingThread row={selectedRow} state={selectedState} app={app} mode={mode} tid={tid} onReply={() => reply(selectedState)} onToggleUnread={() => toggleUnread(selectedRow)} />
                ) : (
                  <div className="thread" data-testid="reading-pane-placeholder">
                    <div className="pane-placeholder">
                      Select a conversation to read it.
                      <br />
                      Opening marks it read here and in the source app.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ReadingThread({
  row,
  state,
  app,
  mode,
  tid,
  onReply,
  onToggleUnread,
}: {
  row: ConversationRow;
  state: ConversationState;
  app: AppState;
  mode: Mode;
  tid: (name: string) => string;
  onReply: () => void;
  onToggleUnread: () => void;
}) {
  const offline = mode === "offline";
  const slug = conversationSlug(row.name, row.service, row.conversationId);
  const last = state.messages[state.messages.length - 1];
  const link = resolveDeepLink(state, app.platform, last?.id);
  return (
    <div className="thread" data-testid={tid(`reading-pane-${slug}`)}>
      <div className="pane-head" data-testid={tid("reading-pane-header")}>
        <Chip service={state.service} />
        <h3>{displayName(state)}</h3>
        <span className="sub">{paneSubline(state, app, offline)}</span>
      </div>
      <ul className="msgs" data-testid={tid("message-list")}>
        {state.messages.map((m, i) => (
          <li className={`msg${m.senderIsMe ? " mine" : ""}`} key={m.id} data-testid={tid(`message-${i + 1}`)}>
            {state.isGroup ? <strong>{m.senderIsMe ? "You" : m.senderName}: </strong> : null}
            {m.body}
            <span className="meta">{messageTime(m.sentAt)}</span>
          </li>
        ))}
      </ul>
      <div className="pane-foot" data-testid={tid("reading-pane-actions")}>
        <Button
          type="button"
          className="btn primary"
          data-testid={tid("button-reply-handoff")}
          disabled={link.disabled}
          title={link.disabled ? `${link.appName} has no app on this device` : undefined}
          onClick={onReply}
        >
          Reply in {link.appName}
        </Button>
        <Button type="button" variant="outline" className="btn" data-testid={tid("button-mark-unread")} disabled={offline} onClick={onToggleUnread}>
          {row.unread ? "Mark read" : "Mark unread"}
        </Button>
        <span className="hint">{replyHint(state.service, link.appName, offline)}</span>
      </div>
    </div>
  );
}
