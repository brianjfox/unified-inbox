import type { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serves the built GUI (FR-24). Every response carries the cross-origin
 * isolation headers the SQLite WebAssembly cache needs for its persistent
 * file system, and the OAuth callback route is served `no-store` so the
 * one-time code is never cached (ADR-10). Unknown paths fall back to
 * index.html so the GUI's own router handles them.
 */
export function mountGui(app: Hono, guiDir: string): void {
  const root = normalize(guiDir);
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/")) return c.notFound();
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) return c.text("Bad path", 400);
    let file = join(root, rel);
    const isCallback = rel.startsWith("/oauth/slack/callback");
    if (!existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, "index.html");
      rel = "/index.html";
    }
    if (!existsSync(file)) {
      return c.text("The GUI has not been built. Run `bun run build:gui` (the dev script does this for you).", 503);
    }
    const headers = new Headers({
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    if (rel === "/index.html" || isCallback) headers.set("Cache-Control", "no-store");
    else if (rel.startsWith("/assets/")) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    else headers.set("Cache-Control", "no-cache");
    const bytes = await Bun.file(file).arrayBuffer();
    return new Response(bytes, { headers });
  });
}
