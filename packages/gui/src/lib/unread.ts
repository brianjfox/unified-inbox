import type { Service } from "@inbox/shared/schema";

export type Filter = "all" | "unread" | Service;

/** The fields the sidebar and list need from a cached conversation. */
export type UnreadRow = { service: Service; unread: boolean };

export type UnreadCounts = { all: number; unread: number; imessage: number; slack: number; whatsapp: number };

/**
 * Sidebar counts are counts of UNREAD conversations (IR-1): each service's
 * count is its unread rows, and they sum to All. Unread and All show the
 * same number because All filters nothing while counting the same thing.
 */
export function unreadCounts(rows: readonly UnreadRow[]): UnreadCounts {
  const counts: UnreadCounts = { all: 0, unread: 0, imessage: 0, slack: 0, whatsapp: 0 };
  for (const r of rows) {
    if (!r.unread) continue;
    counts[r.service] += 1;
  }
  counts.unread = counts.imessage + counts.slack + counts.whatsapp;
  counts.all = counts.unread;
  return counts;
}

export function applyFilter<T extends UnreadRow>(rows: readonly T[], filter: Filter): T[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "unread":
      return rows.filter((r) => r.unread);
    default:
      return rows.filter((r) => r.service === filter);
  }
}

export const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  unread: "Unread",
  imessage: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
};

export const FILTERS: readonly Filter[] = ["all", "unread", "imessage", "slack", "whatsapp"];
