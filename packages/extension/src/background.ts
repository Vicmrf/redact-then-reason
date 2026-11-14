// MV3 service worker: panel behavior, context menu, and the capture message router
// (ARCHITECTURE 3.2, TECH-SPEC 5.2). It is only a router:
// - no Firebase, no AI, no App Check, no placeholder map;
// - page text is never written to chrome.storage. A context-menu capture may wait in this
//   worker's memory for up to PENDING_CAPTURE_TTL_MS until the panel pulls it, then is dropped;
// - page text is never logged.
// Injection happens only on a user gesture (toolbar-opened panel button click or context
// menu) through activeTab + scripting. There is no always-on content script.
import { extractPageText, MAX_CAPTURE_CHARS, type CaptureMode } from "./content/extract";
import {
  MSG_CAPTURE_FAILED,
  MSG_NO_TAB,
  PENDING_CAPTURE_TTL_MS,
  checkTabUrl,
  classifyInjectionError,
  isExtensionPageSender,
  parsePanelRequest,
  validatePageTextPayload,
  type CapturePush,
  type CaptureResult,
} from "./lib/router";

const MENU_ID = "rtr-analyze";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Analyze with Redact-then-Reason",
    contexts: ["selection", "page"],
  });
});

async function fileAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

async function captureTab(tab: chrome.tabs.Tab | undefined, mode: CaptureMode): Promise<CaptureResult> {
  if (!tab?.id) return { ok: false, error: MSG_NO_TAB };
  const urlCheck = checkTabUrl(tab.url, await fileAccessAllowed());
  if (!urlCheck.ok) return urlCheck;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
      args: [mode, MAX_CAPTURE_CHARS],
    });
    const payload = validatePageTextPayload(results[0]?.result);
    return payload ? { ok: true, payload } : { ok: false, error: MSG_CAPTURE_FAILED };
  } catch (err) {
    return { ok: false, error: classifyInjectionError(err instanceof Error ? err.message : String(err)) };
  }
}

async function activeTab(windowId: number | undefined): Promise<chrome.tabs.Tab | undefined> {
  const query: chrome.tabs.QueryInfo =
    windowId !== undefined ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query);
  return tab;
}

// ---- Context-menu capture hand-off (memory only, short-lived) ----
let pending: { push: CapturePush; at: number } | null = null;
let nextCaptureId = 1;

function takePending(): CapturePush | null {
  if (!pending) return null;
  const { push, at } = pending;
  pending = null;
  return Date.now() - at <= PENDING_CAPTURE_TTL_MS ? push : null;
}

async function deliverToPanel(result: CaptureResult): Promise<void> {
  const push: CapturePush = { type: "CONTEXT_CAPTURE", id: nextCaptureId++, result };
  // Keep it in memory first so a panel that is still loading can pull it.
  pending = { push, at: Date.now() };
  setTimeout(() => {
    if (pending?.push.id === push.id) pending = null;
  }, PENDING_CAPTURE_TTL_MS);
  try {
    const ack: unknown = await chrome.runtime.sendMessage(push);
    if (ack && typeof ack === "object" && (ack as { received?: unknown }).received === push.id) {
      if (pending?.push.id === push.id) pending = null;
    }
  } catch {
    // Panel not listening yet: it pulls with GET_PENDING_CAPTURE on load.
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id || tab.windowId === undefined) return;
  // sidePanel.open must run synchronously inside the user gesture.
  const opened = chrome.sidePanel.open({ windowId: tab.windowId });
  const selectionText = typeof info.selectionText === "string" ? info.selectionText : "";
  const mode: CaptureMode = selectionText.trim() ? "selection" : "page";
  void (async () => {
    try {
      await opened;
    } catch {
      // Panel could not open; the capture is still kept for a manual open.
    }
    let result = await captureTab(tab, mode);
    // Selection inside a cross-origin iframe is not readable by the main-frame injection;
    // Chrome hands us the selected string itself, so use that (plain data, capped).
    if (mode === "selection" && result.ok && !result.payload.text.trim()) {
      const text = selectionText.slice(0, MAX_CAPTURE_CHARS);
      result = {
        ok: true,
        payload: { ...result.payload, text, truncated: selectionText.length > MAX_CAPTURE_CHARS },
      };
    }
    await deliverToPanel(result);
  })();
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only this extension's own pages (side panel). Content scripts and other senders are ignored.
  if (!isExtensionPageSender(sender, chrome.runtime.id)) return false;
  const req = parsePanelRequest(msg);
  if (!req) return false;

  switch (req.type) {
    case "GET_TAB_TEXT":
      void (async () => {
        try {
          const tab = await activeTab(req.windowId);
          sendResponse(await captureTab(tab, req.mode));
        } catch {
          sendResponse({ ok: false, error: MSG_CAPTURE_FAILED } satisfies CaptureResult);
        }
      })();
      return true;
    case "GET_PENDING_CAPTURE":
      sendResponse(takePending());
      return false;
    case "OPEN_PANEL":
      void (async () => {
        try {
          const windowId = req.windowId ?? (await chrome.windows.getLastFocused()).id;
          if (windowId === undefined) throw new Error("no window");
          await chrome.sidePanel.open({ windowId });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
      })();
      return true;
  }
});
