import { describe, test, expect } from "bun:test";
import { resolveDeepLink, detectPlatform } from "../src/deeplink.ts";
import { bodyOfFrame, headerOfFrame } from "../src/mail.ts";
import { ConversationState, InboxEvent, previewFor } from "../src/schema.ts";
import { HubBoundEvent } from "../src/protocol.ts";

const slack = { service: "slack" as const, isGroup: false, link: { slack: { teamId: "T1", channelId: "D1", teamDomain: "acme" } }, messages: [{ id: "1700000000.000100", senderName: "Maria", senderIsMe: false, body: "hi", sentAt: "2026-01-01T00:00:00Z" }] };

describe("deep links", () => {
  test("slack reaches the message natively and on the web", () => {
    const l = resolveDeepLink(slack, "macos");
    expect(l.native).toBe("slack://channel?team=T1&id=D1&message=1700000000.000100");
    expect(l.web).toBe("https://acme.slack.com/archives/D1/p1700000000000100");
    expect(l.depth).toBe("message");
    expect(l.disabled).toBe(false);
    expect(l.appName).toBe("Slack");
  });
  test("whatsapp one-to-one reaches the chat; groups only the app", () => {
    const one = resolveDeepLink({ service: "whatsapp", isGroup: false, link: { whatsapp: { jid: "15551234567@s.whatsapp.net", phone: "15551234567" } }, messages: [] }, "windows");
    expect(one.native).toBe("whatsapp://send?phone=15551234567");
    expect(one.web).toBe("https://web.whatsapp.com/send?phone=15551234567");
    expect(one.depth).toBe("conversation");
    const group = resolveDeepLink({ service: "whatsapp", isGroup: true, link: { whatsapp: { jid: "123-456@g.us" } }, messages: [] }, "macos");
    expect(group.depth).toBe("app");
    expect(group.disabled).toBe(false);
  });
  test("imessage opens Messages on Apple platforms and is disabled elsewhere", () => {
    const conv = { service: "imessage" as const, isGroup: false, link: { imessage: { handles: ["+15551234567"], chatGuid: "iMessage;-;+15551234567" } }, messages: [] };
    expect(resolveDeepLink(conv, "macos")).toMatchObject({ native: "imessage://%2B15551234567", web: null, depth: "conversation", disabled: false, appName: "Messages" });
    expect(resolveDeepLink(conv, "windows")).toMatchObject({ native: null, web: null, disabled: true });
    expect(resolveDeepLink(conv, "android").disabled).toBe(true);
    expect(resolveDeepLink(conv, "ios").disabled).toBe(false);
  });
  test("platform detection prefers the shell's answer", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0)", "macos")).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });
});

describe("mail frames", () => {
  test("body and headers are extracted from a frame", () => {
    const raw = "From: a@x\r\nTo: b@x\r\nSubject: unified-inbox/1\r\nMessage-ID: <1@x>\r\n\r\nABC_def-123\r\n";
    expect(bodyOfFrame(raw)).toBe("ABC_def-123");
    expect(headerOfFrame(raw, "subject")).toBe("unified-inbox/1");
    expect(headerOfFrame(raw, "Message-ID")).toBe("<1@x>");
  });
});

describe("schemas", () => {
  test("validate and reject", () => {
    const ok = InboxEvent({ v: 1, service: "slack", conversationId: "D1", conversationName: "Maria", isGroup: false, messageId: "1", senderName: "Maria", senderIsMe: false, body: "x", sentAt: "2026-01-01T00:00:00Z", link: {} });
    expect(ok instanceof Error).toBe(false);
    const bad = InboxEvent({ v: 2, service: "telegram" });
    expect("summary" in (bad as object)).toBe(true);
    const ev = HubBoundEvent({ id: "1", at: "now", type: "triage.markRead", conversationIds: ["a"] });
    expect("summary" in (ev as object)).toBe(false);
    const badEv = HubBoundEvent({ id: "1", at: "now", type: "slack.saveApp", clientId: "" });
    expect("summary" in (badEv as object)).toBe(true);
    const st = ConversationState({ v: 1, service: "whatsapp", conversationId: "j", name: "Crew", isGroup: true, messages: [], lastMessageAt: "2026-01-01T00:00:00Z", preview: "", unread: false, unreadCount: 0, link: {} });
    expect("summary" in (st as object)).toBe(false);
  });
  test("preview names the sender in groups", () => {
    expect(previewFor({ isGroup: true, messages: [{ id: "1", senderName: "Sam", senderIsMe: false, body: "who's  driving\nSaturday?", sentAt: "" }] })).toBe("Sam: who's driving Saturday?");
    expect(previewFor({ isGroup: false, messages: [{ id: "1", senderName: "Sam", senderIsMe: false, body: "hi", sentAt: "" }] })).toBe("hi");
    expect(previewFor({ isGroup: true, messages: [{ id: "1", senderName: "Me", senderIsMe: true, body: "ok", sentAt: "" }] })).toBe("ok");
  });
});
