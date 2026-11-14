// Day-2 "Paste text to redact" section: paste -> redact -> preview (deliberately plain).
// Renders with textContent / createElement only. Never innerHTML.
// The original text is shown only in the textarea the user pasted into; previews show
// masked text, per-type counts and the pre-flight result (types and counts only).
import { PREFLIGHT_BLOCKING_TYPES, preflightCheck, redact, type PlaceholderMap, type TypeCount } from "@rtr/core";
import { clearAll, clearMap, saveMap } from "../lib/sessionStore";

/** In-memory working copy of the current document's map (session storage is the safety net). */
let currentMap: PlaceholderMap | null = null;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in side panel markup`);
  return node as T;
}

function formatCounts(counts: readonly TypeCount[]): string {
  if (counts.length === 0) return "No identifiers detected.";
  return counts.map((c) => `${c.type}: ${c.count}`).join(", ");
}

export function initRedactPanel(): void {
  const input = byId<HTMLTextAreaElement>("redact-input");
  const redactBtn = byId<HTMLButtonElement>("redact-btn");
  const newDocBtn = byId<HTMLButtonElement>("newdoc-btn");
  const preview = byId("redact-preview");
  const masked = byId("redact-masked");
  const counts = byId("redact-counts");
  const preflight = byId("redact-preflight");
  const status = byId("redact-status");

  function resetPreview(): void {
    masked.textContent = "";
    counts.textContent = "";
    preflight.textContent = "";
    preflight.classList.remove("error", "ok");
    preview.hidden = true;
  }

  async function onRedact(): Promise<void> {
    status.textContent = "";
    const text = input.value;
    if (!text.trim()) {
      resetPreview();
      status.textContent = "Paste some text first.";
      return;
    }
    const previousDocId = currentMap?.docId;
    const result = redact(text);
    currentMap = result.map;

    masked.textContent = result.masked;
    counts.textContent = formatCounts(result.counts);

    const check = preflightCheck(result.masked);
    preflight.classList.toggle("error", !check.ok);
    preflight.classList.toggle("ok", check.ok);
    if (check.ok) {
      preflight.textContent = "Pre-flight OK: 0 unmasked emails/SSNs/cards detected in the redacted text.";
    } else {
      const blocking = check.hits.filter((h) => PREFLIGHT_BLOCKING_TYPES.has(h.type));
      preflight.textContent = `Pre-flight BLOCKED: redacted text still contains ${formatCounts(blocking)}. It must not be sent anywhere.`;
    }
    preview.hidden = false;

    try {
      if (previousDocId && previousDocId !== currentMap.docId) await clearMap(previousDocId);
      await saveMap(currentMap);
      status.textContent = `Placeholder map kept in session storage only (${currentMap.entries.length} entries).`;
    } catch (err) {
      status.textContent = `Could not save placeholder map to session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  async function onNewDocument(): Promise<void> {
    input.value = "";
    resetPreview();
    const docId = currentMap?.docId;
    currentMap = null;
    try {
      if (docId) await clearMap(docId);
      await clearAll();
      status.textContent = "Cleared. Nothing from the previous document is kept.";
    } catch (err) {
      status.textContent = `Could not clear session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  redactBtn.addEventListener("click", () => {
    void onRedact();
  });
  newDocBtn.addEventListener("click", () => {
    void onNewDocument();
  });
}
