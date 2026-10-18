#!/usr/bin/env bun
/**
 * Captures the user manual's pictures from the RUNNING application (AGENTS.md):
 * headless Chromium at 1280px wide, a bright highlight around the control each
 * step refers to, PNGs under docs/manual/. It expects the dev stack from
 * `bun run dev` to be up at http://localhost:8787 with the hub running, and
 * needs the hub's process id (HUB_PID) only for the hub-offline picture, which
 * it takes by pausing the hub with SIGSTOP for the staleness window and then
 * resuming it.
 *
 *   bun run dev            # in one terminal
 *   HUB_PID=<pid> bun run scripts/manual-screenshots.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.GUI_URL ?? "http://localhost:8787";
const OUT = new URL("../docs/manual/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

async function highlight(page: Page, testId: string | null, label: string) {
  if (testId) {
    await page.locator(`[data-testid="${testId}"]`).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
  }
  await page.evaluate(({ testId, label }) => {
    document.querySelectorAll("[data-manual-highlight]").forEach((n) => n.remove());
    if (!testId) return;
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`no element with data-testid ${testId}`);
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.setAttribute("data-manual-highlight", "1");
    Object.assign(box.style, {
      position: "fixed",
      left: `${r.left - 6}px`,
      top: `${r.top - 6}px`,
      width: `${r.width + 12}px`,
      height: `${r.height + 12}px`,
      border: "3px solid #ff3d00",
      borderRadius: "10px",
      boxShadow: "0 0 0 3px rgba(255,61,0,.25)",
      pointerEvents: "none",
      zIndex: "99999",
    } as CSSStyleDeclaration);
    const tag = document.createElement("div");
    tag.setAttribute("data-manual-highlight", "1");
    tag.textContent = label;
    const above = r.top > 40;
    Object.assign(tag.style, {
      position: "fixed",
      left: `${Math.max(8, r.left - 6)}px`,
      top: above ? `${r.top - 34}px` : `${r.bottom + 10}px`,
      background: "#ff3d00",
      color: "#fff",
      font: "600 13px -apple-system, system-ui, sans-serif",
      padding: "4px 8px",
      borderRadius: "6px",
      pointerEvents: "none",
      zIndex: "99999",
    } as CSSStyleDeclaration);
    document.body.append(box, tag);
  }, { testId, label });
}

async function shot(page: Page, name: string, testId: string | null, label: string) {
  await highlight(page, testId, label);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`captured ${name}.png`);
}

async function waitForInbox(page: Page) {
  // The hub approves the first viewer within about 15 seconds; the first sync follows.
  await page.waitForSelector('[data-testid="conversation-list"]', { timeout: 120_000 });
}

// A persistent profile: the browser is one device, enrolled once, and a rerun
// of this script reuses it instead of enrolling another device.
const PROFILE = new URL("../tmp/manual-browser-profile/", import.meta.url).pathname;
mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1280, height: 800 } });
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(BASE + "/");
  // The loading state is what a new device sees while waiting for approval.
  const first = await Promise.race([
    page.waitForSelector('[data-testid="loading-skeleton-list"]', { timeout: 30_000 }).then(() => "loading" as const),
    page.waitForSelector('[data-testid="conversation-list"]', { timeout: 30_000 }).then(() => "inbox" as const),
  ]);
  if (first === "loading") await shot(page, "08-loading", "loading-sync-status", "Status while connecting");
  await waitForInbox(page);
  await page.waitForTimeout(1500);
  await shot(page, "01-inbox", "conversation-list", "Every conversation, newest first");
  await shot(page, "02-filters", "inbox-sidebar", "Filters with unread counts");

  const firstRow = page.locator('[data-testid="conversation-list"] [data-testid^="conversation-"]').first();
  await firstRow.locator("button, label").first().click();
  await page.waitForSelector('[data-testid="reading-pane"] [data-testid^="message-"]', { timeout: 10_000 });
  await shot(page, "03-reading-pane", "reading-pane", "The open conversation");
  await shot(page, "04-reply", "button-reply-handoff", "Reply opens the source app");

  await page.fill('[data-testid="inbox-search"]', "the");
  await page.waitForTimeout(800);
  await shot(page, "05-search", "inbox-search", "Search across all services");
  await page.fill('[data-testid="inbox-search"]', "");

  await page.setViewportSize({ width: 402, height: 800 });
  await page.waitForTimeout(500);
  await shot(page, "06-phone", "button-back-to-list", "Back to the list");
  await page.setViewportSize({ width: 1280, height: 800 });

  // Connections screen and its cards.
  await page.click('[data-testid="nav-connections"]');
  await page.waitForSelector('[data-testid="card-hub"]');
  await shot(page, "10-connections", null, "");
  await shot(page, "11-card-hub", "button-hub-restart", "Restart the hub");
  await shot(page, "12-card-imessage", "card-imessage", "iMessage");
  await page.click('[data-testid="button-slack-app-settings"]');
  await shot(page, "13-card-slack", "card-slack", "Slack");
  await shot(page, "14-card-whatsapp", "button-whatsapp-relink", "Show the QR code");
  await shot(page, "15-card-sync", "sync-device-list", "Devices holding a key");
  await page.click('[data-testid="connections-nav-inbox"]');

  // 07: all caught up. Mark all read in the unified view (iMessage read-back is
  // the approved fallback, so no Messages badge changes).
  await page.waitForSelector('[data-testid="button-mark-all-read"]');
  await page.click('[data-testid="button-mark-all-read"]');
  await page.waitForSelector('[data-testid="empty-state"]', { timeout: 15_000 });
  await shot(page, "07-empty", "empty-state", "Nothing is waiting");
  // Let the hub confirm the mark-all-read before it is paused below, so the
  // offline picture shows the offline state alone.
  await page.waitForTimeout(12_000);
  if ((await page.locator('[data-testid="banner-action-error"]').count()) > 0) {
    throw new Error("the hub did not confirm mark all read; check the hub log");
  }

  // 09: hub offline. Pause the hub so heartbeats stop; the viewer notices after 90s.
  const hubPid = Number(process.env.HUB_PID ?? 0);
  if (hubPid > 0) {
    process.kill(hubPid, "SIGSTOP");
    try {
      await page.waitForSelector('[data-testid="banner-hub-offline"]', { timeout: 150_000 });
      await shot(page, "09-offline", "banner-hub-offline", "The hub is unreachable");
    } finally {
      process.kill(hubPid, "SIGCONT");
    }
  } else {
    console.log("HUB_PID not set: skipping 09-offline.png");
  }
} finally {
  await ctx.close();
}
