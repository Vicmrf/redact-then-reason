// Side-panel side of page capture (ARCHITECTURE 3.1-3.2). Talks to the service worker only.
// Every message coming back is validated (shape, types, sender) before use, because the text
// originated in an untrusted page. Nothing here stores or logs page text.
import type { CaptureMode } from "../content/extract";
import {
  MSG_CAPTURE_FAILED,
  isExtensionPageSender,
  parseCapturePush,
  validateCaptureResult,
  type CaptureResult,
} from "../lib/router";

async function currentWindowId(): Promise<number | undefined> {
  try {
    return (await chrome.windows.getCurrent()).id;
  } catch {
    return undefined;
  }
}

/** Asks the SW to read the active tab of this panel's window. Call only from a click handler. */
export async function requestTabText(mode: CaptureMode): Promise<CaptureResult> {
  try {
    const windowId = await currentWindowId();
    const reply: unknown = await chrome.runtime.sendMessage({ type: "GET_TAB_TEXT", mode, windowId });
    return validateCaptureResult(reply) ?? { ok: false, error: MSG_CAPTURE_FAILED };
  } catch {
    return { ok: false, error: MSG_CAPTURE_FAILED };
  }
}

/**
 * Receives context-menu captures: pushed by the SW while the panel is open, or pulled once on
 * load (the SW keeps at most one, in memory, for a short time). Duplicate ids are ignored.
 */
export function listenForContextCaptures(onCapture: (result: CaptureResult) => void): void {
  let lastId = 0;
  const accept = (id: number, result: CaptureResult): void => {
    if (id <= lastId) return;
    lastId = id;
    onCapture(result);
  };

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isExtensionPageSender(sender, chrome.runtime.id)) return false;
    const push = parseCapturePush(msg);
    if (!push) return false;
    accept(push.id, push.result);
    sendResponse({ received: push.id });
    return false;
  });

  void (async () => {
    try {
      const reply: unknown = await chrome.runtime.sendMessage({ type: "GET_PENDING_CAPTURE" });
      const push = parseCapturePush(reply);
      if (push) accept(push.id, push.result);
    } catch {
      // No service worker reply: nothing pending.
    }
  })();
}
