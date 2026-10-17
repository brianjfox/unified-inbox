import { describe, expect, test } from "bun:test";
import { applyFilter, unreadCounts, type UnreadRow } from "../src/lib/unread.ts";

const rows: Array<UnreadRow & { name: string }> = [
  { name: "Maria Chen", service: "slack", unread: true },
  { name: "Dad", service: "imessage", unread: true },
  { name: "Weekend Crew", service: "whatsapp", unread: true },
  { name: "Priya Nair", service: "whatsapp", unread: true },
  { name: "Alex, Jordan", service: "slack", unread: false },
  { name: "Hannah", service: "imessage", unread: false },
];

describe("unreadCounts", () => {
  test("counts unread conversations per service and they sum to All (the design's 1, 1, 2 → 4)", () => {
    const c = unreadCounts(rows);
    expect(c).toEqual({ all: 4, unread: 4, imessage: 1, slack: 1, whatsapp: 2 });
    expect(c.imessage + c.slack + c.whatsapp).toBe(c.all);
  });

  test("is all zeros when nothing is unread", () => {
    expect(unreadCounts(rows.map((r) => ({ ...r, unread: false })))).toEqual({ all: 0, unread: 0, imessage: 0, slack: 0, whatsapp: 0 });
  });
});

describe("applyFilter", () => {
  test("all keeps every row in order", () => {
    expect(applyFilter(rows, "all").map((r) => r.name)).toEqual(rows.map((r) => r.name));
  });
  test("unread keeps only unread rows", () => {
    expect(applyFilter(rows, "unread").map((r) => r.name)).toEqual(["Maria Chen", "Dad", "Weekend Crew", "Priya Nair"]);
  });
  test("a service filter keeps that service's rows, read or not, and its unread count matches its unread rows", () => {
    const slack = applyFilter(rows, "slack");
    expect(slack.map((r) => r.name)).toEqual(["Maria Chen", "Alex, Jordan"]);
    expect(slack.filter((r) => r.unread)).toHaveLength(unreadCounts(rows).slack);
  });
});
