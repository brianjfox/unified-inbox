import { describe, expect, test } from "bun:test";
import { parseOAuthCallback, slackRedirectUri } from "../src/lib/oauth.ts";
import { routeFor } from "../src/lib/router.ts";

describe("parseOAuthCallback", () => {
  test("approval returns the code and state", () => {
    expect(parseOAuthCallback("?code=abc.123&state=st-9")).toEqual({ kind: "code", code: "abc.123", state: "st-9" });
  });
  test("cancelling at Slack returns an error with the reason", () => {
    const r = parseOAuthCallback("?error=access_denied&state=st-9");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("access_denied");
  });
  test("Slack's description is included when present", () => {
    const r = parseOAuthCallback("error=invalid_scope&error_description=bad+scope");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toBe("Slack refused the connection: bad scope (invalid_scope)");
  });
  test("a code without a state is invalid", () => {
    expect(parseOAuthCallback("?code=abc").kind).toBe("invalid");
  });
  test("an empty query is invalid", () => {
    expect(parseOAuthCallback("").kind).toBe("invalid");
  });
});

describe("slackRedirectUri", () => {
  test("is the GUI's callback route at the relay's origin", () => {
    expect(slackRedirectUri("https://inbox.example.net")).toBe("https://inbox.example.net/oauth/slack/callback");
    expect(slackRedirectUri("https://inbox.example.net/")).toBe("https://inbox.example.net/oauth/slack/callback");
  });
});

describe("routeFor", () => {
  test("maps the three routes and keeps the callback's query", () => {
    expect(routeFor("/", "")).toEqual({ name: "inbox" });
    expect(routeFor("/connections", "")).toEqual({ name: "connections" });
    expect(routeFor("/connections/", "")).toEqual({ name: "connections" });
    expect(routeFor("/oauth/slack/callback", "?code=a&state=b")).toEqual({ name: "oauth-slack-callback", search: "?code=a&state=b" });
    expect(routeFor("/nope", "")).toEqual({ name: "unknown", path: "/nope" });
  });
});
