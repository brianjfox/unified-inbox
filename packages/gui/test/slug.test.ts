import { describe, expect, test } from "bun:test";
import { conversationSlug, slugify } from "../src/lib/slug.ts";

describe("slugify", () => {
  test("matches the design's row ids", () => {
    expect(slugify("Maria Chen")).toBe("maria-chen");
    expect(slugify("Dad")).toBe("dad");
    expect(slugify("Weekend Crew")).toBe("weekend-crew");
    expect(slugify("Alex, Jordan")).toBe("alex-jordan");
    expect(slugify("Priya Nair")).toBe("priya-nair");
  });
  test("drops accents and collapses punctuation", () => {
    expect(slugify("Zoë  O'Brien – (work)")).toBe("zoe-o-brien-work");
    expect(slugify("Woodshop Collective")).toBe("woodshop-collective");
  });
});

describe("conversationSlug", () => {
  test("uses the name when it has ASCII letters", () => {
    expect(conversationSlug("Maria Chen", "slack", "C123")).toBe("maria-chen");
  });
  test("falls back to service and id for a name with no ASCII", () => {
    expect(conversationSlug("山田太郎", "imessage", "iMessage;-;+15551234567")).toBe("imessage-imessage-15551234567");
  });
});
