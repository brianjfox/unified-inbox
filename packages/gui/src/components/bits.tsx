import type { ReactNode } from "react";
import type { Service } from "@inbox/shared/schema";

/** The service tag ("Slack", "iMsg", "WA") in the design's colors. */
export function Chip({ service }: { service: Service }) {
  const cls = service === "imessage" ? "imsg" : service === "slack" ? "slack" : "wa";
  const label = service === "imessage" ? "iMsg" : service === "slack" ? "Slack" : "WA";
  return <span className={`chip ${cls}`}>{label}</span>;
}

export type PillTone = "ok" | "err" | "warn" | "neutral";

export function StatusPill({ tone, children, testId }: { tone: PillTone; children: ReactNode; testId?: string }) {
  return (
    <span className={`status-pill ${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: "ok" | "err" | "warn" }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}
