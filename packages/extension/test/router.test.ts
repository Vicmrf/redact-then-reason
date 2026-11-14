// Pure SW router helpers (ARCHITECTURE 3.2): URL restrictions, payload validation, senders.
import { describe, expect, it } from "vitest";
import {
  MAX_TITLE_CHARS,
  MSG_FILE_NOT_ALLOWED,
  MSG_NEED_FRESH_CLICK,
  MSG_RESTRICTED,
  checkTabUrl,
  classifyInjectionError,
  describeSource,
  isExtensionPageSender,
  isRestrictedUrl,
  parseCapturePush,
  parsePanelRequest,
  validateCaptureResult,
  validatePageTextPayload,
} from "../src/lib/router";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

describe("restricted URLs", () => {
  it.each([
    "chrome://extensions/",
    "chrome://settings",
    "edge://settings",
    "chrome-extension://otherextensionid/page.html",
    "about:blank",
    "view-source:https://example.com/",
    "devtools://devtools/bundled/inspector.html",
    "data:text/html,hi",
    "javascript:void(0)",
    "https://chromewebstore.google.com/detail/x/y",
    "https://chrome.google.com/webstore/detail/x",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isRestrictedUrl(url)).toBe(true);
    const r = checkTabUrl(url, true);
    expect(r).toEqual({ ok: false, error: MSG_RESTRICTED });
  });

  it.each(["https://mail.example.com/inbox", "http://localhost:8080/medical-email.html", "https://chrome.google.com/other"])(
    "allows %s",
    (url) => {
      expect(checkTabUrl(url, false)).toEqual({ ok: true });
      expect(isRestrictedUrl(url)).toBe(false);
    },
  );

  it("file:// only when file access is allowed", () => {
    expect(checkTabUrl("file:///C:/testdata/pages/medical-email.html", false)).toEqual({ ok: false, error: MSG_FILE_NOT_ALLOWED });
    expect(checkTabUrl("file:///C:/testdata/pages/medical-email.html", true)).toEqual({ ok: true });
    expect(isRestrictedUrl("file:///x.html", false)).toBe(true);
  });

  it("unknown URL (no activeTab grant) asks for a fresh click", () => {
    expect(checkTabUrl(undefined, false)).toEqual({ ok: false, error: MSG_NEED_FRESH_CLICK });
    expect(isRestrictedUrl(undefined)).toBe(false);
  });

  it("maps scripting errors to fixed messages without echoing them", () => {
    expect(classifyInjectionError("Cannot access contents of url \"https://x.example/secret?q=1\". Extension manifest must request permission to access this host.")).toBe(MSG_NEED_FRESH_CLICK);
    expect(classifyInjectionError("Cannot access a chrome:// URL")).toBe(MSG_RESTRICTED);
    expect(classifyInjectionError("The extensions gallery cannot be scripted.")).toBe(MSG_RESTRICTED);
    expect(classifyInjectionError("weird failure with jane.example@example.com")).not.toContain("example.com");
  });
});

describe("payload validation", () => {
  const good = { type: "PAGE_TEXT", text: "hello", url: "https://a.example/", title: "T", mode: "page", truncated: false };

  it("accepts a well-formed payload and strips extra fields", () => {
    const out = validatePageTextPayload({ ...good, html: "<b>x</b>", extra: 1 });
    expect(out).toEqual(good);
    expect(Object.keys(out!).sort()).toEqual(["mode", "text", "title", "truncated", "type", "url"]);
  });

  it.each([
    null,
    "PAGE_TEXT",
    { ...good, type: "OTHER" },
    { ...good, text: 42 },
    { ...good, url: null },
    { ...good, title: { toString: () => "x" } },
    { ...good, mode: "everything" },
    { ...good, truncated: "yes" },
  ])("rejects bad shape %#", (bad) => {
    expect(validatePageTextPayload(bad)).toBeNull();
  });

  it("re-caps oversized text and long titles", () => {
    const out = validatePageTextPayload({ ...good, text: "x".repeat(50), title: "t".repeat(2000) }, 10);
    expect(out!.text.length).toBe(10);
    expect(out!.truncated).toBe(true);
    expect(out!.title.length).toBe(MAX_TITLE_CHARS);
  });

  it("validates capture results and pushes", () => {
    expect(validateCaptureResult({ ok: true, payload: good })).toEqual({ ok: true, payload: good });
    expect(validateCaptureResult({ ok: true, payload: { ...good, text: 1 } })).toBeNull();
    expect(validateCaptureResult({ ok: false, error: "nope" })).toEqual({ ok: false, error: "nope" });
    expect(validateCaptureResult({ ok: false, error: 5 })).toBeNull();
    expect(parseCapturePush({ type: "CONTEXT_CAPTURE", id: 3, result: { ok: true, payload: good } })).toEqual({
      type: "CONTEXT_CAPTURE",
      id: 3,
      result: { ok: true, payload: good },
    });
    expect(parseCapturePush({ type: "CONTEXT_CAPTURE", id: "3", result: { ok: true, payload: good } })).toBeNull();
    expect(parseCapturePush({ type: "PAGE_TEXT", ...good })).toBeNull();
  });

  it("describes the source with title and hostname only", () => {
    expect(describeSource({ title: "Inbox  -  Mail", url: "https://mail.example.com/u/0/#inbox/abc?x=1", truncated: false })).toBe(
      "Captured from: Inbox - Mail (mail.example.com)",
    );
    expect(describeSource({ title: "", url: "file:///C:/x.html", truncated: true })).toBe(
      "Captured from: Untitled page (local file), truncated",
    );
  });
});

describe("request parsing", () => {
  it("parses known requests", () => {
    expect(parsePanelRequest({ type: "GET_TAB_TEXT", mode: "selection" })).toEqual({ type: "GET_TAB_TEXT", mode: "selection" });
    expect(parsePanelRequest({ type: "GET_TAB_TEXT", mode: "page", windowId: 7 })).toEqual({ type: "GET_TAB_TEXT", mode: "page", windowId: 7 });
    expect(parsePanelRequest({ type: "GET_TAB_TEXT", mode: "page", windowId: "7" })).toEqual({ type: "GET_TAB_TEXT", mode: "page" });
    expect(parsePanelRequest({ type: "OPEN_PANEL" })).toEqual({ type: "OPEN_PANEL" });
    expect(parsePanelRequest({ type: "GET_PENDING_CAPTURE" })).toEqual({ type: "GET_PENDING_CAPTURE" });
  });

  it("rejects unknown or malformed requests", () => {
    expect(parsePanelRequest(null)).toBeNull();
    expect(parsePanelRequest({ type: "GET_TAB_TEXT" })).toBeNull();
    expect(parsePanelRequest({ type: "GET_TAB_TEXT", mode: "all" })).toBeNull();
    expect(parsePanelRequest({ type: "PAGE_TEXT", text: "x" })).toBeNull();
    expect(parsePanelRequest({ type: "EVAL", code: "1" })).toBeNull();
  });
});

describe("sender validation", () => {
  const panelUrl = `chrome-extension://${EXT}/src/sidepanel/index.html`;

  it("accepts this extension's own pages", () => {
    expect(isExtensionPageSender({ id: EXT, url: panelUrl }, EXT)).toBe(true);
    expect(isExtensionPageSender({ id: EXT, url: `chrome-extension://${EXT}/service-worker-loader.js` }, EXT)).toBe(true);
  });

  it("rejects content scripts (sender.tab set), other extensions and web pages", () => {
    expect(isExtensionPageSender({ id: EXT, url: "https://mail.example.com/", tab: { id: 1 } }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT, url: panelUrl, tab: { id: 1 } }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: "otherextensionidotherextensionid", url: panelUrl }, EXT)).toBe(false);
    expect(isExtensionPageSender({ url: "https://evil.example/" }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT, url: "https://evil.example/" }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: "", url: "" }, "")).toBe(false);
  });
});
