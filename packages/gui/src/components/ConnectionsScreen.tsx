import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Card, Input } from "@corbits/react-ui";
import type { DeviceRecord, HubStatus } from "@inbox/shared/schema";
import { useAppState, store, type AppState } from "../lib/store.ts";
import { session } from "../lib/session.ts";
import { navigate } from "../lib/router.ts";
import { slugify } from "../lib/slug.ts";
import { clockTime, shortDate } from "../lib/time.ts";
import { slackRedirectUri } from "../lib/oauth.ts";
import { Chip, StatusPill, type PillTone } from "./bits.tsx";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs a Connections action and surfaces its failure on the screen. */
function useAction(): [string | null, (fn: () => Promise<void>) => Promise<void>, boolean] {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return [error, run, busy];
}

export function ConnectionsScreen() {
  const app = useAppState();
  useEffect(() => {
    void session.refreshDevices();
    void session.refreshHubStatus();
    const t = window.setInterval(() => void session.refreshDevices(), 10_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <section className="screen" data-testid="screen-connections" aria-label="Connections">
      <div className="app">
        <aside className="sidebar" aria-label="Navigation">
          <div className="brand">Inbox</div>
          <nav aria-label="App sections">
            <a className="navlink" href="/" data-testid="connections-nav-inbox" onClick={(e) => (e.preventDefault(), navigate("/"))}>
              ← Back to inbox
            </a>
            <button type="button" className="navlink" aria-current="true" data-testid="connections-nav-connections">
              Connections
            </button>
          </nav>
        </aside>
        <div className="main">
          <div className="conn-wrap">
            <h2>Connections</h2>
            <HubCard app={app} />
            <IMessageCard app={app} />
            <SlackCard app={app} />
            <WhatsAppCard app={app} />
            <SyncCard app={app} />
          </div>
        </div>
      </div>
    </section>
  );
}

function HubCard({ app }: { app: AppState }) {
  const [error, run, busy] = useAction();
  const status = app.hubStatus;
  const record = app.hubRecord;
  const name = status?.hubName ?? record?.label ?? "Mac hub";
  const beat = record?.lastHeartbeatAt ? clockTime(record.lastHeartbeatAt) : "never";
  return (
    <Card className="card" data-testid="card-hub">
      <div className="card-head">
        <h3>Mac hub</h3>
        <StatusPill tone={app.hubOffline ? "err" : "ok"}>{app.hubOffline ? "Unreachable" : "Online"}</StatusPill>
        <Button type="button" variant="outline" className="btn" data-testid="button-hub-restart" disabled={busy || app.hubOffline} onClick={() => void run(() => session.restartHub())}>
          Restart hub
        </Button>
      </div>
      {record ? (
        <p>
          {name} · last heartbeat {beat} · starts at boot and restarts itself. All three services connect through this machine; if it's unreachable, the whole inbox goes stale until it's back.
        </p>
      ) : (
        <p>No hub has enrolled yet. Install the connector hub on your always-on Mac; it appears here after its first heartbeat.</p>
      )}
      {status ? <p>Hub version {status.version}.</p> : null}
      {app.hubStatusError ? <p className="error-text">{app.hubStatusError}</p> : null}
      {app.lastSyncError ? <p className="error-text">Last sync problem: {app.lastSyncError}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </Card>
  );
}

function imessagePill(state: HubStatus["imessage"]["state"] | undefined): { tone: PillTone; label: string } {
  switch (state) {
    case "connected":
      return { tone: "ok", label: "Connected" };
    case "no-full-disk-access":
      return { tone: "err", label: "No Full Disk Access" };
    case "paused":
      return { tone: "warn", label: "Paused" };
    case "error":
      return { tone: "err", label: "Error" };
    case "unavailable":
      return { tone: "err", label: "Unavailable" };
    default:
      return { tone: "neutral", label: "Unknown" };
  }
}

function IMessageCard({ app }: { app: AppState }) {
  const [error, run, busy] = useAction();
  const im = app.hubStatus?.imessage;
  const pill = imessagePill(im?.state);
  const paused = im?.state === "paused";
  const fda = im?.state === "no-full-disk-access" ? "not granted" : im ? "granted" : "unknown";
  const readBack =
    im?.readBack === "per-conversation"
      ? "Marking read writes back per conversation, not per message — that's as fine as iMessage allows."
      : "Marking read here does not clear the badge in Messages on the Mac: iMessage offers no safe way to write read state back, so read-back is unavailable for iMessage.";
  return (
    <Card className="card" data-testid="card-imessage">
      <div className="card-head">
        <Chip service="imessage" />
        <h3>iMessage</h3>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        <Button type="button" variant="outline" className="btn" data-testid="button-imessage-pause" disabled={busy || app.hubOffline || !im} onClick={() => void run(() => session.setImessagePaused(!paused))}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <p>
        Read from Messages on the Mac hub. Full Disk Access: {fda}. {readBack}
      </p>
      {im && im.detail ? <p>{im.detail}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </Card>
  );
}

function slackPill(state: HubStatus["slack"]["state"] | undefined): { tone: PillTone; label: string } {
  switch (state) {
    case "connected":
      return { tone: "ok", label: "Connected" };
    case "not-configured":
      return { tone: "err", label: "Not set up" };
    case "no-workspaces":
      return { tone: "warn", label: "No workspaces" };
    case "error":
      return { tone: "err", label: "Error" };
    default:
      return { tone: "neutral", label: "Unknown" };
  }
}

function SlackCard({ app }: { app: AppState }) {
  const [removeError, runRemove, removing] = useAction();
  const [saveError, runSave, saving] = useAction();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [appToken, setAppToken] = useState("");
  const slack = app.hubStatus?.slack;
  const pill = slackPill(slack?.state);
  const appConfigured = slack?.appConfigured === true;
  const connectDisabled = !appConfigured || app.hubOffline || app.slackConnectBusy;
  const connectReason = !appConfigured ? "Save the Slack app settings below first." : app.hubOffline ? "Unavailable while the hub is offline." : null;
  const redirect = slackRedirectUri(window.location.origin);
  return (
    <Card className="card" data-testid="card-slack">
      <div className="card-head">
        <Chip service="slack" />
        <h3>Slack</h3>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        <Button
          type="button"
          className="btn primary"
          data-testid="button-slack-add-workspace"
          disabled={connectDisabled}
          title={connectReason ?? undefined}
          aria-describedby={connectReason ? "slack-connect-reason" : undefined}
          onClick={() => void session.startSlackConnect()}
        >
          {app.slackConnectBusy ? "Connecting…" : "Connect a workspace"}
        </Button>
        {connectReason ? (
          <span className="head-note" id="slack-connect-reason" data-testid="slack-connect-disabled-reason">
            {connectReason}
          </span>
        ) : null}
      </div>
      <ul data-testid="slack-workspace-list">
        {slack && slack.workspaces.length > 0 ? (
          slack.workspaces.map((w) => (
            <li key={w.teamId}>
              {w.name} — authorized {shortDate(w.authorizedAt)}
              {w.connected ? "" : w.error ? ` — ${w.error}` : " — not connected"}{" "}
              <Button
                type="button"
                variant="link"
                className="iconbtn inline danger"
                data-testid={`button-slack-remove-${slugify(w.name) || w.teamId.toLowerCase()}`}
                disabled={removing || app.hubOffline}
                onClick={() => void runRemove(() => session.removeSlackWorkspace(w.teamId))}
              >
                Remove
              </Button>
            </li>
          ))
        ) : (
          <li>No workspaces connected yet.</li>
        )}
      </ul>
      {slack && slack.detail ? <p>{slack.detail}</p> : null}
      {removeError ? <p className="error-text">{removeError}</p> : null}
      {app.slackConnectError ? (
        <p className="error-text" data-testid="slack-connect-error" role="alert">
          {app.slackConnectError}
        </p>
      ) : null}
      {app.slackNotice ? (
        <p className="notice-text" data-testid="slack-notice">
          {app.slackNotice}
        </p>
      ) : null}
      <p data-testid="slack-connect-help">
        Connect a workspace opens Slack's authorization page in this window; approve it there and you land back here with the workspace listed under its Slack name. If you cancel at Slack, or Slack refuses, the reason shows here and nothing is added. Your Mac hub does the token exchange, so the token is stored only on the
        Mac.
      </p>
      <details data-testid="slack-app-settings">
        <summary className="btn" data-testid="button-slack-app-settings">
          Slack app settings
        </summary>
        <p>
          One-time setup. Create a Slack app at api.slack.com/apps, turn on public distribution so it can be installed in each of your workspaces, enable Socket Mode and create an app-level token with the <code>connections:write</code> scope, subscribe to the user events <code>message.im</code> and{" "}
          <code>message.mpim</code>, add the redirect URL and user-token scopes below, then paste the app's Client ID, Client Secret and app-level token here. They travel encrypted to your Mac hub and are stored only there — the sync server never sees them.
        </p>
        <p>
          Redirect URL: <code data-testid="slack-redirect-url">{redirect}</code>
          <br />
          User-token scopes: <code>im:history im:read im:write mpim:history mpim:read mpim:write users:read</code>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSave(async () => {
              await session.saveSlackApp(clientId.trim(), clientSecret.trim(), appToken.trim());
              setClientSecret("");
              setAppToken("");
            });
          }}
        >
          <div className="token-row">
            <label htmlFor="slack-client-id">Client ID</label>
            <Input id="slack-client-id" type="text" data-testid="input-slack-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder="1234567890.0987654321" />
          </div>
          <div className="token-row">
            <label htmlFor="slack-client-secret">Client Secret</label>
            <Input id="slack-client-secret" type="password" data-testid="input-slack-client-secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </div>
          <div className="token-row">
            <label htmlFor="slack-app-token">App-level token</label>
            <Input id="slack-app-token" type="password" data-testid="input-slack-app-token" value={appToken} onChange={(e) => setAppToken(e.target.value)} autoComplete="off" placeholder="xapp-…" />
            <Button type="submit" variant="outline" className="btn" data-testid="button-slack-save-app" disabled={saving || app.hubOffline || !clientId.trim() || !clientSecret.trim() || !appToken.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
        {saveError ? (
          <p className="error-text" data-testid="slack-app-settings-error">
            {saveError}
          </p>
        ) : null}
      </details>
    </Card>
  );
}

function whatsappPill(state: HubStatus["whatsapp"]["state"] | undefined): { tone: PillTone; label: string; err: boolean } {
  switch (state) {
    case "connected":
      return { tone: "ok", label: "Connected", err: false };
    case "linking":
      return { tone: "warn", label: "Linking…", err: false };
    case "not-linked":
      return { tone: "neutral", label: "Not linked", err: false };
    case "expired":
      return { tone: "err", label: "Session expired", err: true };
    case "error":
      return { tone: "err", label: "Error", err: true };
    default:
      return { tone: "neutral", label: "Unknown", err: false };
  }
}

function whatsappText(wa: HubStatus["whatsapp"] | undefined): string {
  switch (wa?.state) {
    case "expired":
      return "The linked-device session ended on WhatsApp's side (this happens periodically). The inbox keeps what it already synced; new WhatsApp messages won't arrive until you relink.";
    case "not-linked":
      return "WhatsApp isn't linked yet. The inbox receives WhatsApp messages once this hub is linked as a device; the button below starts the link.";
    case "linking":
      return "Waiting for a phone scan. Keep this card open until the code is scanned.";
    case "connected":
      return `Linked as a device on the Mac hub${wa.phone ? ` (${wa.phone})` : ""}. Relinking replaces the current session.`;
    case "error":
      return wa.detail || "The WhatsApp connection failed.";
    default:
      return "The hub has not reported the WhatsApp session state yet.";
  }
}

function WhatsAppCard({ app }: { app: AppState }) {
  const wa = app.hubStatus?.whatsapp;
  const pill = whatsappPill(wa?.state);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !app.whatsappQr) return;
    QRCode.toCanvas(canvas, app.whatsappQr, { width: 300, margin: 1 }).catch((err: unknown) => store.set({ whatsappError: `The QR code could not be drawn: ${errText(err)}` }));
  }, [app.whatsappQr]);
  const shown = app.whatsappQrShown;
  return (
    <Card className={`card${pill.err ? " err" : ""}`} data-testid="card-whatsapp">
      <div className="card-head">
        <Chip service="whatsapp" />
        <h3>WhatsApp</h3>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>
      <p>
        {whatsappText(wa)} {wa?.state === "expired" || wa?.state === "connected" ? "" : "Before the first link, this same card reads Not linked and the same button starts the link."}
      </p>
      {wa && wa.detail && wa.state !== "error" ? <p>{wa.detail}</p> : null}
      <div className="qr-row" data-testid="whatsapp-relink-panel">
        <div className="qr-text">
          <p>On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the code. One session, on the hub only — the same posture as leaving WhatsApp Web open.</p>
          <Button
            type="button"
            className="btn primary"
            data-testid="button-whatsapp-relink"
            style={{ marginTop: 10 }}
            aria-expanded={shown}
            disabled={app.hubOffline}
            title={app.hubOffline ? "Unavailable while the hub is offline" : undefined}
            onClick={() => (shown ? session.hideWhatsAppQr() : void session.showWhatsAppQr())}
          >
            {shown ? "Hide QR code" : "Show QR code"}
          </Button>
          {app.whatsappError ? (
            <p className="error-text" data-testid="whatsapp-link-error" role="alert">
              {app.whatsappError}
            </p>
          ) : null}
        </div>
        {shown ? (
          <div className={`qr-box${app.whatsappQr ? " has-code" : ""}`} data-testid="whatsapp-qr-placeholder" role="img" aria-label="QR code for linking this hub as a WhatsApp device">
            {app.whatsappQr ? <canvas ref={canvasRef} /> : "Waiting for the hub's QR code…"}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function deviceLine(d: DeviceRecord, selfId: string | null): string {
  const marker = d.kind === "hub" ? " (hub)" : d.id === selfId ? " (this machine)" : "";
  const state = d.revokedAt ? "revoked" : d.approvedAt ? "key enrolled" : "waiting for approval";
  return `${d.label}${marker} — ${state}`;
}

function SyncCard({ app }: { app: AppState }) {
  const [error, run, busy] = useAction();
  const devices = app.devices.filter((d) => !d.revokedAt);
  return (
    <Card className="card" data-testid="card-sync">
      <div className="card-head">
        <h3>Sync &amp; encryption</h3>
        <StatusPill tone="ok">End-to-end encrypted</StatusPill>
      </div>
      <p>The sync server relays your inbox between machines but cannot read it — only your own devices hold the keys.</p>
      <ul data-testid="sync-device-list">
        {devices.length === 0 ? <li>{app.devicesError ? `The device list could not be loaded: ${app.devicesError}` : "Loading devices…"}</li> : null}
        {devices.map((d) => {
          const pending = !d.approvedAt;
          const self = d.id === app.deviceId;
          return (
            <li key={d.id}>
              {deviceLine(d, app.deviceId)}
              {pending ? (
                <>
                  {" "}
                  <Button type="button" variant="link" className="iconbtn inline" data-testid={`button-approve-device-${d.id}`} disabled={busy} onClick={() => void run(() => session.approveDevice(d.id))}>
                    Approve
                  </Button>
                  <Button type="button" variant="link" className="iconbtn inline danger" data-testid={`button-revoke-device-${d.id}`} disabled={busy} onClick={() => void run(() => session.revokeDevice(d.id))}>
                    Decline
                  </Button>
                </>
              ) : self ? null : (
                <>
                  {" "}
                  <Button type="button" variant="link" className="iconbtn inline danger" data-testid={`button-revoke-device-${d.id}`} disabled={busy} onClick={() => void run(() => session.revokeDevice(d.id))}>
                    Revoke
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {devices.length > 0 && app.devicesError ? <p className="error-text">The device list could not be refreshed: {app.devicesError}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </Card>
  );
}
