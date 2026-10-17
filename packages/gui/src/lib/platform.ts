import { invoke } from "@tauri-apps/api/core";
import { detectPlatform, type DeepLink, type Platform } from "@inbox/shared/deeplink";

declare global {
  interface Window {
    /** Present only inside the Tauri desktop shell (withGlobalTauri). */
    __TAURI__?: unknown;
  }
}

/** True when the GUI runs inside the Tauri desktop shell on Mac or Windows. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI__ !== undefined;
}

/**
 * Which platform Reply resolves deep links for. Inside the shell the shell
 * says ("macos" | "windows" | "linux"); in a browser the user agent does.
 */
export async function currentPlatform(): Promise<Platform> {
  if (inTauri()) {
    const p = await invoke<string>("platform");
    return detectPlatform(navigator.userAgent, p);
  }
  return detectPlatform(navigator.userAgent);
}

/** A readable default label for this device's enrollment: "Chrome on macOS". */
export function defaultDeviceLabel(platform: Platform): string {
  const ua = navigator.userAgent;
  const browser = inTauri()
    ? "Desktop app"
    : /edg\//i.test(ua)
      ? "Edge"
      : /opr\//i.test(ua)
        ? "Opera"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /firefox|fxios/i.test(ua)
            ? "Firefox"
            : /safari/i.test(ua)
              ? "Safari"
              : "Browser";
  const os: Record<Platform, string> = { macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", android: "Android", unknown: "this device" };
  return `${browser} on ${os[platform]}`;
}

export type OpenResult = { opened: "native" | "web" | "none" };

/**
 * Reply handoff (FR-13, FR-14). In the shell, the shell opens the native link
 * and falls back to the web link itself. In a browser the page tries the
 * native scheme; if the page is still visible 1.5 seconds later no app took
 * it, so the web version opens in a new tab.
 */
export async function openDeepLink(link: DeepLink): Promise<OpenResult> {
  if (link.disabled) return { opened: "none" };
  if (inTauri()) {
    return invoke<OpenResult>("open_deep_link", { native: link.native, web: link.web });
  }
  if (link.native) {
    window.location.assign(link.native);
    if (!link.web) return { opened: "native" };
    const web = link.web;
    return new Promise<OpenResult>((resolve) => {
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          window.open(web, "_blank", "noopener");
          resolve({ opened: "web" });
        } else {
          resolve({ opened: "native" });
        }
      }, 1500);
    });
  }
  if (link.web) {
    window.open(link.web, "_blank", "noopener");
    return { opened: "web" };
  }
  return { opened: "none" };
}
