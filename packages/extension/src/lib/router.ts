// Pure helpers for the service-worker message router (ARCHITECTURE 3.2) and the panel side
// of capture. No chrome.* calls here so they are unit-testable. No Firebase, no model, no
// placeholder map, no storage.
import { MAX_CAPTURE_CHARS, type CaptureMode, type PageTextPayload } from "../content/extract";

export const MAX_TITLE_CHARS = 500;
export const MAX_URL_CHARS = 2048;
/** Context-menu captures wait in SW memory (never chrome.storage) at most this long. */
export const PENDING_CAPTURE_TTL_MS = 60_000;

export const MSG_NEED_FRESH_CLICK =
  "Chrome needs a fresh click to read this tab: click the extension's toolbar icon (or right-click > Analyze with Redact-then-Reason) and try again.";
export const MSG_RESTRICTED =
  "Chrome does not let extensions read this page (browser pages, the Chrome Web Store, other extensions). Copy the text and paste it instead.";
export const MSG_FILE_NOT_ALLOWED =
  "To read local files, turn on \"Allow access to file URLs\" for Redact-then-Reason in chrome://extensions, or serve the file with a local static server.";
export const MSG_NO_TAB = "No active tab found in this window.";
export const MSG_CAPTURE_FAILED = "Could not read this page. Copy the text and paste it instead.";

export type PanelRequest =
  | { type: "GET_TAB_TEXT"; mode: CaptureMode; windowId?: number }
  | { type: "OPEN_PANEL"; windowId?: number }
  | { type: "GET_PENDING_CAPTURE" };

export type CaptureResult = { ok: true; payload: PageTextPayload } | { ok: false; error: string };

/** SW -> panel push after a context-menu capture. */
export interface CapturePush {
  type: "CONTEXT_CAPTURE";
  id: number;
  result: CaptureResult;
}

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/**
 * True only for messages from this extension's own pages (side panel, service worker).
 * Content scripts carry `sender.tab`; other extensions / web pages have another id.
 */
export function isExtensionPageSender(sender: SenderLike, extensionId: string): boolean {
  if (!extensionId || sender.id !== extensionId) return false;
  if (sender.tab !== undefined && sender.tab !== null) return false;
  return typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${extensionId}/`);
}

function isWindowId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function parsePanelRequest(msg: unknown): PanelRequest | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "GET_TAB_TEXT":
      if (m.mode !== "selection" && m.mode !== "page") return null;
      return isWindowId(m.windowId)
        ? { type: "GET_TAB_TEXT", mode: m.mode, windowId: m.windowId }
        : { type: "GET_TAB_TEXT", mode: m.mode };
    case "OPEN_PANEL":
      return isWindowId(m.windowId) ? { type: "OPEN_PANEL", windowId: m.windowId } : { type: "OPEN_PANEL" };
    case "GET_PENDING_CAPTURE":
      return { type: "GET_PENDING_CAPTURE" };
    default:
      return null;
  }
}

export type UrlCheck = { ok: true } | { ok: false; error: string };

/**
 * Only http(s) pages, and file:// when the user allowed file access, may be scripted.
 * An unknown URL (no activeTab grant yet) needs a fresh user click.
 */
export function checkTabUrl(url: string | undefined, allowFileAccess: boolean): UrlCheck {
  if (!url) return { ok: false, error: MSG_NEED_FRESH_CLICK };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: MSG_RESTRICTED };
  }
  if (u.protocol === "file:") {
    return allowFileAccess ? { ok: true } : { ok: false, error: MSG_FILE_NOT_ALLOWED };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: MSG_RESTRICTED };
  const host = u.hostname.toLowerCase();
  if (host === "chromewebstore.google.com") return { ok: false, error: MSG_RESTRICTED };
  if (host === "chrome.google.com" && (u.pathname === "/webstore" || u.pathname.startsWith("/webstore/"))) {
    return { ok: false, error: MSG_RESTRICTED };
  }
  return { ok: true };
}

/** Convenience: true when the URL can never be scripted (or file access is off). */
export function isRestrictedUrl(url: string | undefined, allowFileAccess = false): boolean {
  const r = checkTabUrl(url, allowFileAccess);
  return !r.ok && r.error !== MSG_NEED_FRESH_CLICK;
}

/** Maps a chrome.scripting error to a fixed, honest message (never echoes page data). */
export function classifyInjectionError(message: string): string {
  if (/cannot be scripted|chrome:\/\/|extensions gallery|webstore/i.test(message)) return MSG_RESTRICTED;
  if (/file/i.test(message) && /access|permission/i.test(message)) return MSG_FILE_NOT_ALLOWED;
  if (/cannot access|permission|must request|activeTab|host/i.test(message)) return MSG_NEED_FRESH_CLICK;
  if (/no tab|tab.*not found/i.test(message)) return MSG_NO_TAB;
  return MSG_CAPTURE_FAILED;
}

/**
 * Validates an untrusted PAGE_TEXT payload (it came from the page's world). Returns a fresh
 * object with only the expected string/boolean fields, or null if the shape is wrong.
 */
export function validatePageTextPayload(x: unknown, maxChars = MAX_CAPTURE_CHARS): PageTextPayload | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (p.type !== "PAGE_TEXT") return null;
  if (typeof p.text !== "string" || typeof p.url !== "string" || typeof p.title !== "string") return null;
  if (p.mode !== "selection" && p.mode !== "page") return null;
  if (p.truncated !== undefined && typeof p.truncated !== "boolean") return null;
  let truncated = p.truncated === true;
  let text = p.text;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return {
    type: "PAGE_TEXT",
    text,
    url: p.url.slice(0, MAX_URL_CHARS),
    title: p.title.slice(0, MAX_TITLE_CHARS),
    mode: p.mode,
    truncated,
  };
}

export function validateCaptureResult(x: unknown): CaptureResult | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (r.ok === true) {
    const payload = validatePageTextPayload(r.payload);
    return payload ? { ok: true, payload } : null;
  }
  if (r.ok === false && typeof r.error === "string") return { ok: false, error: r.error.slice(0, 500) };
  return null;
}

export function parseCapturePush(x: unknown): CapturePush | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  if (m.type !== "CONTEXT_CAPTURE" || typeof m.id !== "number" || !Number.isFinite(m.id)) return null;
  const result = validateCaptureResult(m.result);
  return result ? { type: "CONTEXT_CAPTURE", id: m.id, result } : null;
}

/** "Captured from: <title> (<hostname>)" pieces; hostname only, never the full URL. */
export function describeSource(payload: Pick<PageTextPayload, "title" | "url" | "truncated">): string {
  let host = "";
  try {
    const u = new URL(payload.url);
    host = u.protocol === "file:" ? "local file" : u.hostname;
  } catch {
    host = "unknown page";
  }
  const title = payload.title.replace(/\s+/g, " ").trim() || "Untitled page";
  return `Captured from: ${title} (${host})${payload.truncated ? ", truncated" : ""}`;
}
