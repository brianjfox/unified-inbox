/** "12:31 PM", as the design shows every time of day. */
export function clockTime(iso: string | Date, now: Date = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  void now;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The row's time column: today → "12:31 PM", yesterday → "Yesterday",
 * otherwise a short date ("Sep 3", or "Sep 3, 2025" in another year).
 */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, now)) return clockTime(d);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A message's timestamp: the time today, otherwise date and time. */
export function messageTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, now)) return clockTime(d);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clockTime(d)}`;
}

/** "01/14/2025", as the Slack workspace list shows authorization dates. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}
