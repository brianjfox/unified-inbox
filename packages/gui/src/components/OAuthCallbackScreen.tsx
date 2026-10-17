import { useEffect, useRef } from "react";
import { useAppState, store } from "../lib/store.ts";
import { session } from "../lib/session.ts";
import { navigate } from "../lib/router.ts";
import { parseOAuthCallback } from "../lib/oauth.ts";
import { Dot } from "./bits.tsx";

/**
 * Slack sends the browser back here (FR-19). The one-time code goes to the
 * Mac hub sealed; the hub exchanges it with the client secret it alone
 * holds. Nothing here is cached: the relay serves this route `no-store`, and
 * the URL is replaced with /connections as soon as the result is known.
 */
export function OAuthCallbackScreen({ search }: { search: string }) {
  const app = useAppState();
  const ran = useRef(false);
  const ready = app.phase.kind === "ready";
  const hubKnown = app.hubRecord !== null;

  useEffect(() => {
    if (ran.current) return;
    const parsed = parseOAuthCallback(search);
    if (parsed.kind !== "code") {
      ran.current = true;
      store.set({ slackConnectError: parsed.message, slackConnectBusy: false });
      navigate("/connections", { replace: true });
      return;
    }
    if (!ready || !hubKnown) return;
    ran.current = true;
    void session.finishSlackConnect(parsed.code, parsed.state).finally(() => navigate("/connections", { replace: true }));
  }, [search, ready, hubKnown]);

  const status = app.phase.kind === "unreachable" ? "Can't reach the sync server" : app.phase.kind === "pending-approval" ? "Waiting for this device to be approved…" : !hubKnown ? "Connecting to hub…" : "Finishing the Slack connection…";

  return (
    <section className="screen" data-testid="screen-oauth-callback" aria-label="Connecting Slack">
      <div className="app">
        <aside className="sidebar" aria-label="Navigation">
          <div className="brand">Inbox</div>
          <div className="sidefoot" data-testid="oauth-sync-status">
            <span className="dotline">
              <Dot tone={app.phase.kind === "unreachable" ? "err" : "warn"} />
              {status}
            </span>
          </div>
        </aside>
        <div className="main">
          <div className="conn-wrap">
            <h2>Connecting Slack</h2>
            <p>Handing Slack's one-time code to your Mac hub. You'll be back on the Connections screen in a moment.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
