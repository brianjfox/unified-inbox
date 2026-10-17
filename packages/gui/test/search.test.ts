import { describe, expect, test } from "bun:test";
import { ftsQuery } from "../src/db/cache.ts";

describe("ftsQuery", () => {
  test("quotes each word as a prefix term", () => {
    expect(ftsQuery("deck")).toBe('"deck"*');
    expect(ftsQuery("maria deck")).toBe('"maria"* "deck"*');
  });
  test("escapes quotes and FTS operators so user text never becomes syntax", () => {
    expect(ftsQuery('say "hi" OR NOT')).toBe('"say"* """hi"""* "OR"* "NOT"*');
  });
  test("is empty for whitespace", () => {
    expect(ftsQuery("   ")).toBe("");
  });
});
