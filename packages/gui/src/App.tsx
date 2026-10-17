import { useAppState } from "./lib/store.ts";
import { useRoute } from "./lib/router.ts";
import { InboxScreen } from "./components/InboxScreen.tsx";
import { ConnectionsScreen } from "./components/ConnectionsScreen.tsx";
import { OAuthCallbackScreen } from "./components/OAuthCallbackScreen.tsx";

/** A named thing is missing and nothing else can be shown (AGENTS.md: fail visibly). */
function FatalScreen({ title, message, deviceId }: { title: string; message: string; deviceId: string | null }) {
  return (
    <main className="screen-error" data-testid="screen-error" role="alert">
      <h1>{title}</h1>
      <p>{message}</p>
      {deviceId ? (
        <p>
          This device's id: <code>{deviceId}</code>
        </p>
      ) : null}
    </main>
  );
}

export function App() {
  const state = useAppState();
  const route = useRoute();
  if (state.phase.kind === "fatal") return <FatalScreen title={state.phase.title} message={state.phase.message} deviceId={state.deviceId} />;
  if (route.name === "oauth-slack-callback") return <OAuthCallbackScreen search={route.search} />;
  if (state.phase.kind !== "ready") return <InboxScreen />;
  if (route.name === "connections") return <ConnectionsScreen />;
  return <InboxScreen />;
}
