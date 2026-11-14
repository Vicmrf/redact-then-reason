// Paste/capture -> Redact -> Explain / Draft reply flow (BUILD-PLAN Days 3-4, ARCHITECTURE 3.3, 4.1):
// capture (user click or context menu only) or paste -> Redact -> deterministic preview (instant)
// -> ONLY_ON_DEVICE LLM entity pass on the raw text -> verify -> merge -> re-mask -> preview +
// counts + map in chrome.storage.session
// -> Explain on-device (raw text, ONLY_ON_DEVICE stream) or Draft reply on-device (redacted
//    text, ONLY_ON_DEVICE stream) -> unmask locally -> badge from inferenceSource.
//
// Nothing here calls the cloud. If Nano is unavailable or a model call fails, an honest message
// is shown; there is no automatic cloud fallback.
// Renders with textContent only. Never innerHTML. Never logs raw text, page text, model output,
// or the map.
import {
  InferenceSource,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  PREFLIGHT_BLOCKING_TYPES,
  TOO_LONG_FOR_DRAFT,
  buildDraftPrompt,
  buildExplainPrompt,
  draftFitsOnDevice,
  draftReplyOnDevice,
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
import type { CaptureMode } from "../content/extract";
import { describeSource, type CaptureResult } from "../lib/router";
import { clearAll, clearMap, saveMap } from "../lib/sessionStore";
import { listenForContextCaptures, requestTabText } from "./captureClient";

/** ARCHITECTURE 3.3 state names (Day-4 subset; consent / cloud states arrive on Day 5). */
export type PanelState =
  | "idle"
  | "capturing"
  | "redacting"
  | "ready"
  | "explaining"
  | "drafting"
  | "done"
  | "error";

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
const BUSY_STATES: ReadonlySet<PanelState> = new Set(["capturing", "redacting", "explaining", "drafting"]);

let state: PanelState = "idle";
/** In-memory working copy of the current document's map (session storage is the safety net). */
let currentMap: PlaceholderMap | null = null;
/** Raw text the current map was built from. Stays in this panel's memory only. */
let currentRaw: string | null = null;
/** Redacted text for the current map (what the draft prompt sees). */
let currentMasked: string | null = null;
/** Last unmasked draft, for the Copy button. Panel memory only. */
let lastDraft = "";
/** Bumped on every Redact / New document / capture so stale async work cannot overwrite newer state. */
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

  const captureSelBtn = byId<HTMLButtonElement>("capture-selection-btn");
  const capturePageBtn = byId<HTMLButtonElement>("capture-page-btn");
  const captureSource = byId("capture-source");
  const captureError = byId("capture-error");

  const explainBtn = byId<HTMLButtonElement>("explain-btn");
  const explainStep = byId("explain-step");
  const explainResult = byId("explain-result");
  const explainText = byId("explain-text");
  const explainWarning = byId("explain-warning");
  const explainSource = byId("explain-source");
  const explainError = byId("explain-error");

  const draftInstruction = byId<HTMLInputElement>("draft-instruction");
  const draftBtn = byId<HTMLButtonElement>("draft-btn");
  const draftStep = byId("draft-step");
  const draftResult = byId("draft-result");
  const draftText = byId("draft-text");
  const draftWarning = byId("draft-warning");
  const draftSource = byId("draft-source");
  const draftCopyBtn = byId<HTMLButtonElement>("draft-copy-btn");
  const draftError = byId("draft-error");

  /** True when a redaction exists and the textarea still holds exactly the redacted document. */
  function docReady(): boolean {
    return (
      (state === "ready" || state === "done") &&
      currentRaw !== null &&
      currentMasked !== null &&
      input.value === currentRaw
    );
  }

  function setState(next: PanelState): void {
    state = next;
    const busy = BUSY_STATES.has(next);
    redactBtn.disabled = busy;
    newDocBtn.disabled = busy;
    captureSelBtn.disabled = busy;
    capturePageBtn.disabled = busy;
    // Explain and Draft are mutually exclusive: both need ready/done and neither may run while busy.
    explainBtn.disabled = !docReady();
    draftBtn.disabled = !docReady();
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

  function resetDraft(): void {
    lastDraft = "";
    draftStep.textContent = "";
    draftText.textContent = "";
    draftSource.textContent = "";
    draftWarning.textContent = "";
    draftWarning.hidden = true;
    draftResult.hidden = true;
    draftCopyBtn.hidden = true;
    draftCopyBtn.textContent = "Copy draft";
    draftError.textContent = "";
    draftError.hidden = true;
  }

  function clearCaptureMessages(): void {
    captureSource.textContent = "";
    captureError.textContent = "";
    captureError.hidden = true;
  }

  function showCaptureError(msg: string): void {
    captureError.textContent = msg;
    captureError.hidden = false;
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
    if (BUSY_STATES.has(state)) return;
    const myRun = ++runId;
    status.textContent = "";
    resetExplain();
    resetDraft();
    const raw = input.value;
    if (!raw.trim()) {
      resetPreview();
      currentRaw = null;
      currentMasked = null;
      status.textContent = "Paste or capture some text first.";
      setState("idle");
      return;
    }
    setState("redacting");
    const previousDocId = currentMap?.docId;

    // 1. Deterministic redaction: instant preview.
    const base = redact(raw);
    currentMap = base.map;
    currentRaw = raw;
    currentMasked = base.masked;
    llmNote.textContent = "";
    renderRedaction(base);
    await storeMap(base.map, previousDocId);
    if (myRun !== runId) return;

    // 2. On-device LLM pass (same docId so the stored map is replaced, not duplicated).
    const withLlm = await runLlmPass(raw, base.map.docId, myRun);
    if (myRun !== runId) return;
    if (withLlm) {
      currentMap = withLlm.map;
      currentMasked = withLlm.masked;
      renderRedaction(withLlm);
      await storeMap(withLlm.map, undefined);
      if (myRun !== runId) return;
    }
    setState("ready");
  }

  async function onExplain(): Promise<void> {
    if (!docReady()) return;
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

  async function onDraft(): Promise<void> {
    if (!docReady()) return;
    const redacted = currentMasked;
    const map = currentMap;
    if (redacted === null || map === null) return;
    const myRun = runId;
    const instruction = draftInstruction.value;
    resetDraft();

    // Day-4 router guard (ARCHITECTURE 3.6): over budget -> no model call at all.
    if (!draftFitsOnDevice(buildDraftPrompt(redacted, instruction))) {
      draftStep.textContent = TOO_LONG_FOR_DRAFT;
      return;
    }
    if (!isFirebaseInitialized()) {
      draftStep.textContent = "On-device draft unavailable: Firebase is not initialized (see Status). Nothing was sent anywhere.";
      return;
    }

    setState("drafting");
    try {
      draftStep.textContent = "Preparing Gemini Nano...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      draftStep.textContent =
        "Drafting on-device from the redacted text (ONLY_ON_DEVICE, streaming). Placeholders are filled in locally when it finishes...";
      draftResult.hidden = false;
      const outcome = await draftReplyOnDevice(redacted, instruction, (chunk) => {
        draftText.textContent += chunk;
      });
      if (myRun !== runId) return;
      if (outcome.kind === "too_long") {
        draftText.textContent = "";
        draftResult.hidden = true;
        draftStep.textContent = outcome.message;
        setState("ready");
        return;
      }
      // Unmask LOCALLY with the in-memory map; the map never went into the prompt.
      const out = unmask(outcome.text, map);
      draftText.textContent = out.text;
      lastDraft = out.text;
      if (out.suspects > 0) {
        draftWarning.textContent = `Hid ${out.suspects} identifier(s) in the draft that did not come from your document's placeholder map.`;
        draftWarning.hidden = false;
      }
      draftSource.textContent = outcome.inferenceSource;
      deps.setBadge(outcome.inferenceSource);
      if (outcome.inferenceSource === InferenceSource.ON_DEVICE) {
        deps.setPrivacy("Nothing has left this device.");
      }
      draftCopyBtn.hidden = lastDraft.length === 0;
      draftStep.textContent = "Done. Review the draft before sending it.";
      setState("done");
    } catch (err) {
      if (myRun !== runId) return;
      // Never show partial output from a failed or refused call.
      lastDraft = "";
      draftText.textContent = "";
      draftResult.hidden = true;
      draftCopyBtn.hidden = true;
      draftStep.textContent = "Failed.";
      draftError.textContent = `On-device draft failed (${errLabel(err)}). Nothing was sent to the cloud; there is no automatic cloud fallback.`;
      draftError.hidden = false;
      setState("error");
      setState("ready");
    }
  }

  function onCopyDraft(): void {
    if (!lastDraft) return;
    void navigator.clipboard.writeText(lastDraft).then(
      () => {
        draftCopyBtn.textContent = "Copied";
      },
      () => {
        draftCopyBtn.textContent = "Copy failed";
      },
    );
  }

  /** Drops the current document, its map and all results ("New document"). */
  async function resetDocument(): Promise<void> {
    runId++;
    input.value = "";
    draftInstruction.value = "";
    resetPreview();
    resetExplain();
    resetDraft();
    clearCaptureMessages();
    const docId = currentMap?.docId;
    currentMap = null;
    currentRaw = null;
    currentMasked = null;
    setState("idle");
    try {
      if (docId) await clearMap(docId);
      await clearAll();
      status.textContent = "Cleared. Nothing from the previous document is kept.";
    } catch (err) {
      status.textContent = `Could not clear session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  async function onNewDocument(): Promise<void> {
    if (BUSY_STATES.has(state)) return;
    await resetDocument();
  }

  /** Puts captured text into the textarea (as a value, never HTML). Does not run any model. */
  async function applyCapture(result: CaptureResult, mode: CaptureMode | null): Promise<void> {
    if (!result.ok) {
      showCaptureError(result.error);
      return;
    }
    const { payload } = result;
    if (!payload.text.trim()) {
      showCaptureError(
        (mode ?? payload.mode) === "selection" ? "No text selected on the page." : "No readable text found on this page.",
      );
      return;
    }
    await resetDocument();
    input.value = payload.text;
    captureSource.textContent = describeSource(payload);
    status.textContent = `Captured ${payload.text.length.toLocaleString()} characters. Review them, then click Redact.`;
  }

  async function onCaptureClick(mode: CaptureMode): Promise<void> {
    if (BUSY_STATES.has(state)) return;
    const previous = state;
    clearCaptureMessages();
    setState("capturing");
    captureSource.textContent = mode === "selection" ? "Reading the selection..." : "Reading the page...";
    let result: CaptureResult;
    try {
      result = await requestTabText(mode);
    } finally {
      captureSource.textContent = "";
      setState(previous);
    }
    await applyCapture(result, mode);
  }

  function onContextCapture(result: CaptureResult): void {
    if (BUSY_STATES.has(state)) {
      clearCaptureMessages();
      showCaptureError("Busy with the current step. Wait for it to finish, then use Capture again.");
      return;
    }
    clearCaptureMessages();
    void applyCapture(result, null);
  }

  input.addEventListener("input", () => {
    // Results must match the redacted document; edits require a new Redact.
    const hadDoc = (state === "ready" || state === "done") && currentRaw !== null;
    setState(state);
    if (hadDoc && input.value !== currentRaw) {
      explainStep.textContent = "Text changed. Click Redact again before explaining.";
      draftStep.textContent = "Text changed. Click Redact again before drafting.";
    } else if (hadDoc) {
      explainStep.textContent = "";
      draftStep.textContent = "";
    }
  });
  redactBtn.addEventListener("click", () => {
    void onRedact();
  });
  explainBtn.addEventListener("click", () => {
    void onExplain();
  });
  draftBtn.addEventListener("click", () => {
    void onDraft();
  });
  draftCopyBtn.addEventListener("click", onCopyDraft);
  newDocBtn.addEventListener("click", () => {
    void onNewDocument();
  });
  captureSelBtn.addEventListener("click", () => {
    void onCaptureClick("selection");
  });
  capturePageBtn.addEventListener("click", () => {
    void onCaptureClick("page");
  });
  setState("idle");
  listenForContextCaptures(onContextCapture);
}
