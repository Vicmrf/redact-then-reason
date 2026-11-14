// Day-3 "Paste text to redact" + "Explain on-device" flow (BUILD-PLAN Day 3, ARCHITECTURE 3.3, 4.1):
// paste -> Redact -> deterministic preview (instant) -> ONLY_ON_DEVICE LLM entity pass on the
// raw text -> verify -> merge -> re-mask -> preview + counts + map in chrome.storage.session
// -> Explain on-device -> generateContentStream (ONLY_ON_DEVICE) -> unmask -> badge from inferenceSource.
//
// Nothing here calls the cloud. If Nano is unavailable or a model call fails, the regex-only
// redaction stays and an honest message is shown; there is no automatic cloud fallback.
// Renders with textContent only. Never innerHTML. Never logs raw text, model output, or the map.
import {
  InferenceSource,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  PREFLIGHT_BLOCKING_TYPES,
  buildExplainPrompt,
  extractEntitiesOnDevice,
  fitsOnDeviceBudget,
  generateOnDeviceStream,
  isFirebaseInitialized,
  preflightCheck,
  probeNano,
  redact,
  redactWithLlm,
  startDeviceModel,
  unmask,
  type PlaceholderMap,
  type RedactResult,
  type TypeCount,
} from "@rtr/core";
import { clearAll, clearMap, saveMap } from "../lib/sessionStore";

/** ARCHITECTURE 3.3 state names (the Day-3 subset; capturing / drafting / consent come later). */
export type PanelState = "idle" | "redacting" | "ready" | "explaining" | "done" | "error";

export interface PanelDeps {
  /** Binds the header badge to a GenerateResult.inferenceSource value. */
  setBadge: (inferenceSource: string) => void;
  /** Existing Nano download-progress UI (0..100). */
  setProgress: (pct: number) => void;
  /** Re-reads Nano availability into the status card. */
  refreshNano: () => void;
  /** One-line privacy status in the footer. */
  setPrivacy: (line: string) => void;
}

const TOO_LONG_FOR_EXPLAIN =
  "Too long for on-device explain. The consented cloud path arrives later (Day 5).";

let state: PanelState = "idle";
/** In-memory working copy of the current document's map (session storage is the safety net). */
let currentMap: PlaceholderMap | null = null;
/** Raw text the current map was built from. Stays in this panel's memory only. */
let currentRaw: string | null = null;
/** Bumped on every Redact / New document so stale async work cannot overwrite newer state. */
let runId = 0;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in side panel markup`);
  return node as T;
}

function formatCounts(counts: readonly TypeCount[]): string {
  if (counts.length === 0) return "No identifiers detected.";
  return counts.map((c) => `${c.type}: ${c.count}`).join(", ");
}

/** Error name + message only (SDK errors; never document text). */
function errLabel(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
}

export function initRedactPanel(deps: PanelDeps): void {
  const input = byId<HTMLTextAreaElement>("redact-input");
  const redactBtn = byId<HTMLButtonElement>("redact-btn");
  const newDocBtn = byId<HTMLButtonElement>("newdoc-btn");
  const preview = byId("redact-preview");
  const masked = byId("redact-masked");
  const counts = byId("redact-counts");
  const preflight = byId("redact-preflight");
  const status = byId("redact-status");
  const llmNote = byId("redact-llm-note");

  const explainBtn = byId<HTMLButtonElement>("explain-btn");
  const explainStep = byId("explain-step");
  const explainResult = byId("explain-result");
  const explainText = byId("explain-text");
  const explainWarning = byId("explain-warning");
  const explainSource = byId("explain-source");
  const explainError = byId("explain-error");

  function setState(next: PanelState): void {
    state = next;
    const busy = next === "redacting" || next === "explaining";
    redactBtn.disabled = busy;
    newDocBtn.disabled = busy;
    explainBtn.disabled = !(next === "ready" || next === "done") || currentRaw === null;
  }

  function resetPreview(): void {
    masked.textContent = "";
    counts.textContent = "";
    preflight.textContent = "";
    preflight.classList.remove("error", "ok");
    preview.hidden = true;
    llmNote.textContent = "";
  }

  function resetExplain(): void {
    explainStep.textContent = "";
    explainText.textContent = "";
    explainSource.textContent = "";
    explainWarning.textContent = "";
    explainWarning.hidden = true;
    explainResult.hidden = true;
    explainError.textContent = "";
    explainError.hidden = true;
  }

  function renderRedaction(result: RedactResult): void {
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
  }

  async function storeMap(map: PlaceholderMap, previousDocId: string | undefined): Promise<void> {
    try {
      if (previousDocId && previousDocId !== map.docId) await clearMap(previousDocId);
      await saveMap(map);
      status.textContent = `Placeholder map kept in session storage only (${map.entries.length} entries).`;
    } catch (err) {
      status.textContent = `Could not save placeholder map to session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  /** Runs the ONLY_ON_DEVICE entity pass. Returns null (with a visible note) when skipped or failed. */
  async function runLlmPass(raw: string, docId: string, myRun: number): Promise<RedactResult | null> {
    if (raw.length > LLM_EXTRACT_MAX_CHARS) {
      llmNote.textContent = `${LLM_SKIPPED_TOO_LONG_NOTE}. Showing regex-only redaction.`;
      return null;
    }
    if (!isFirebaseInitialized()) {
      llmNote.textContent = "On-device entity pass unavailable: Firebase is not initialized (see Status). Showing regex-only redaction.";
      return null;
    }
    let availability = "unavailable";
    try {
      availability = await probeNano();
    } catch {
      // treat as unavailable
    }
    if (availability === "unavailable") {
      llmNote.textContent = "Gemini Nano is unavailable on this device, so names/organizations/addresses were not extracted. Showing regex-only redaction. Nothing was sent to the cloud.";
      return null;
    }
    try {
      llmNote.textContent =
        availability === "available"
          ? "Running on-device entity pass (Gemini Nano)..."
          : "Preparing Gemini Nano (first run downloads the model; progress shown in the On-device card)...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      deps.refreshNano();
      if (myRun !== runId) return null;
      llmNote.textContent = "Running on-device entity pass (Gemini Nano)...";
      const { detections, warnings } = await extractEntitiesOnDevice(raw);
      if (myRun !== runId) return null;
      const result = redactWithLlm(raw, detections, { docId });
      const extra = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
      llmNote.textContent = `On-device entity pass added ${detections.length} verified span(s) before merging.${extra}`;
      return result;
    } catch (err) {
      if (myRun === runId) {
        llmNote.textContent = `On-device entity pass failed (${errLabel(err)}). Showing regex-only redaction. Nothing was sent to the cloud.`;
      }
      return null;
    }
  }

  async function onRedact(): Promise<void> {
    if (state === "redacting" || state === "explaining") return;
    const myRun = ++runId;
    status.textContent = "";
    resetExplain();
    const raw = input.value;
    if (!raw.trim()) {
      resetPreview();
      currentRaw = null;
      status.textContent = "Paste some text first.";
      setState("idle");
      return;
    }
    setState("redacting");
    const previousDocId = currentMap?.docId;

    // 1. Deterministic redaction: instant preview.
    const base = redact(raw);
    currentMap = base.map;
    currentRaw = raw;
    llmNote.textContent = "";
    renderRedaction(base);
    await storeMap(base.map, previousDocId);
    if (myRun !== runId) return;

    // 2. On-device LLM pass (same docId so the stored map is replaced, not duplicated).
    const withLlm = await runLlmPass(raw, base.map.docId, myRun);
    if (myRun !== runId) return;
    if (withLlm) {
      currentMap = withLlm.map;
      renderRedaction(withLlm);
      await storeMap(withLlm.map, undefined);
      if (myRun !== runId) return;
    }
    setState("ready");
  }

  async function onExplain(): Promise<void> {
    if (state !== "ready" && state !== "done") return;
    const raw = currentRaw;
    const map = currentMap;
    if (raw === null || map === null) return;
    const myRun = runId;
    resetExplain();

    // Day-3 router (ARCHITECTURE 3.6): over budget -> no model call at all.
    const prompt = buildExplainPrompt(raw);
    if (!fitsOnDeviceBudget(prompt)) {
      explainStep.textContent = TOO_LONG_FOR_EXPLAIN;
      return;
    }
    if (!isFirebaseInitialized()) {
      explainStep.textContent = "On-device explain unavailable: Firebase is not initialized (see Status). Nothing was sent anywhere.";
      return;
    }

    setState("explaining");
    try {
      explainStep.textContent = "Preparing Gemini Nano...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      explainStep.textContent = "Explaining on-device (ONLY_ON_DEVICE, streaming)...";
      explainResult.hidden = false;
      const { text, inferenceSource } = await generateOnDeviceStream(prompt, (chunk) => {
        explainText.textContent += chunk;
      });
      if (myRun !== runId) return;
      // Keep suspect-PII handling consistent with the cloud path (usually a no-op here).
      const out = unmask(text, map);
      explainText.textContent = out.text;
      if (out.suspects > 0) {
        explainWarning.textContent = `Hid ${out.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
        explainWarning.hidden = false;
      }
      explainSource.textContent = inferenceSource;
      deps.setBadge(inferenceSource);
      if (inferenceSource === InferenceSource.ON_DEVICE) {
        deps.setPrivacy("Nothing has left this device.");
      }
      explainStep.textContent = "Done.";
      setState("done");
    } catch (err) {
      if (myRun !== runId) return;
      // Never show partial output from a call we refused (e.g. unexpected inference source).
      explainText.textContent = "";
      explainResult.hidden = true;
      explainStep.textContent = "Failed.";
      explainError.textContent = `On-device explain failed (${errLabel(err)}). Nothing was sent to the cloud; there is no automatic cloud fallback.`;
      explainError.hidden = false;
      setState("error");
      // The redaction is still valid: allow another try.
      setState("ready");
    }
  }

  async function onNewDocument(): Promise<void> {
    if (state === "redacting" || state === "explaining") return;
    runId++;
    input.value = "";
    resetPreview();
    resetExplain();
    const docId = currentMap?.docId;
    currentMap = null;
    currentRaw = null;
    setState("idle");
    try {
      if (docId) await clearMap(docId);
      await clearAll();
      status.textContent = "Cleared. Nothing from the previous document is kept.";
    } catch (err) {
      status.textContent = `Could not clear session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  input.addEventListener("input", () => {
    // The explanation must match the redacted document; edits require a new Redact.
    if ((state === "ready" || state === "done") && currentRaw !== null && input.value !== currentRaw) {
      explainBtn.disabled = true;
      explainStep.textContent = "Text changed. Click Redact again before explaining.";
    } else if ((state === "ready" || state === "done") && input.value === currentRaw) {
      explainBtn.disabled = false;
      explainStep.textContent = "";
    }
  });
  redactBtn.addEventListener("click", () => {
    void onRedact();
  });
  explainBtn.addEventListener("click", () => {
    void onExplain();
  });
  newDocBtn.addEventListener("click", () => {
    void onNewDocument();
  });
  setState("idle");
}
