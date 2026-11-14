// Paste/capture -> Redact -> Explain / Draft reply flow (BUILD-PLAN Days 3-5, ARCHITECTURE 3.3,
// 3.6, 4.1, 4.2, 5):
// capture (user click or context menu only) or paste -> Redact -> deterministic preview (instant)
// -> ONLY_ON_DEVICE LLM entity pass on the raw text -> verify -> merge -> re-mask -> preview +
// counts + map in chrome.storage.session
// -> Explain / Draft: router (decideRoute) first.
//    on_device   -> ONLY_ON_DEVICE stream (explain: raw text; draft: redacted text)
//    offer_cloud -> consent gate (<dialog>) showing the EXACT redacted payload. Only the gate's
//                   Send click calls ONLY_IN_CLOUD, after pre-flight AND the placeholder-map
//                   leak check both pass on that payload.
// -> unmask locally -> badge from inferenceSource.
//
// There is no automatic cloud fallback: an on-device failure only OFFERS the gate.
// Renders with textContent only. Never innerHTML. Never logs raw text, page text, payloads,
// model output, or the map.
import {
  InferenceSource,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  MapLeakError,
  PreflightError,
  assertNoMapLeaks,
  assertPreflight,
  buildCloudPayload,
  checkCloudSend,
  buildDraftPrompt,
  buildExplainPrompt,
  decideRoute,
  draftReplyOnDevice,
  extractEntitiesOnDevice,
  generateInCloudStream,
  generateOnDeviceStream,
  isFirebaseInitialized,
  normalizeDraftInstruction,
  preflightCheck,
  probeNano,
  redact,
  redactWithLlm,
  startDeviceModel,
  summarizeMasked,
  unmask,
  type CloudPayload,
  type HardQuestionFamily,
  type PlaceholderMap,
  type RedactResult,
  type RouteDecision,
  type RouteReason,
  type TypeCount,
} from "@rtr/core";
import type { CaptureMode } from "../content/extract";
import {
  CONSENT_DESTINATION,
  CONSENT_LEDE,
  CONSENT_TITLE,
  NOTHING_LEFT,
  SEND_LABEL,
  cancelLine,
  cloudStatusLine,
  consentCountsLine,
  leakLine,
  preflightLine,
  reasonLine,
} from "../lib/consentCopy";
import { describeSource, type CaptureResult } from "../lib/router";
import { clearAll, clearMap, saveMap } from "../lib/sessionStore";
import { listenForContextCaptures, requestTabText } from "./captureClient";

/** ARCHITECTURE 3.3 state names. */
export type PanelState =
  | "idle"
  | "capturing"
  | "redacting"
  | "ready"
  | "explaining"
  | "drafting"
  | "awaiting_consent"
  | "cloud_running"
  | "done"
  | "error";

export interface PanelDeps {
  /** Binds the header badge to a GenerateResult.inferenceSource value. */
  setBadge: (inferenceSource: string) => void;
  /** Header badge "pending consent" while the consent gate is open (ARCHITECTURE 3.3). */
  setPendingConsent: (pending: boolean) => void;
  /** Existing Nano download-progress UI (0..100). */
  setProgress: (pct: number) => void;
  /** Re-reads Nano availability into the status card. */
  refreshNano: () => void;
  /** One-line privacy status in the footer. */
  setPrivacy: (line: string) => void;
}

type Action = "explain" | "draft";

const BUSY_STATES: ReadonlySet<PanelState> = new Set([
  "capturing",
  "redacting",
  "explaining",
  "drafting",
  "awaiting_consent",
  "cloud_running",
]);

let state: PanelState = "idle";
/** In-memory working copy of the current document's map (session storage is the safety net). */
let currentMap: PlaceholderMap | null = null;
/** Raw text the current map was built from. Stays in this panel's memory only. */
let currentRaw: string | null = null;
/** Redacted text for the current map (what the draft prompt and the cloud payload see). */
let currentMasked: string | null = null;
/** Last unmasked draft, for the Copy button. Panel memory only. */
let lastDraft = "";
/** Last action the user started; the header cloud button opens the gate for it. */
let lastAction: Action = "explain";
/** Bumped on every Redact / New document / capture so stale async work cannot overwrite newer state. */
let runId = 0;

interface PendingConsent {
  action: Action;
  /** Built once; shown verbatim in the preview; this same object's text is what Send sends. */
  payload: CloudPayload;
  map: PlaceholderMap;
  runId: number;
}
let pending: PendingConsent | null = null;

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

/** Probe result mapped for the router. A failed probe counts as unavailable. */
async function nanoIsAvailable(): Promise<boolean> {
  try {
    return (await probeNano()) !== "unavailable";
  } catch {
    return false;
  }
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
  const explainCloudBtn = byId<HTMLButtonElement>("explain-cloud-btn");
  const explainStep = byId("explain-step");
  const explainResult = byId("explain-result");
  const explainText = byId("explain-text");
  const explainWarning = byId("explain-warning");
  const explainSource = byId("explain-source");
  const explainError = byId("explain-error");

  const draftInstruction = byId<HTMLInputElement>("draft-instruction");
  const draftBtn = byId<HTMLButtonElement>("draft-btn");
  const draftCloudBtn = byId<HTMLButtonElement>("draft-cloud-btn");
  const draftStep = byId("draft-step");
  const draftResult = byId("draft-result");
  const draftText = byId("draft-text");
  const draftWarning = byId("draft-warning");
  const draftSource = byId("draft-source");
  const draftCopyBtn = byId<HTMLButtonElement>("draft-copy-btn");
  const draftError = byId("draft-error");

  const cloudGateBtn = byId<HTMLButtonElement>("cloud-gate-btn");
  const dialog = byId<HTMLDialogElement>("consent-dialog");
  const consentReasons = byId("consent-reasons");
  const consentChars = byId("consent-chars");
  const consentPreview = byId("consent-preview");
  const consentCounts = byId("consent-counts");
  const consentBlocked = byId("consent-blocked");
  const consentCancel = byId<HTMLButtonElement>("consent-cancel");
  const consentSend = byId<HTMLButtonElement>("consent-send");

  // Static gate copy (ARCHITECTURE 5 items 1, 2, 5, 6).
  byId("consent-title").textContent = CONSENT_TITLE;
  byId("consent-lede").textContent = CONSENT_LEDE;
  byId("consent-destination").textContent = CONSENT_DESTINATION;
  consentSend.textContent = SEND_LABEL;

  const ui = {
    explain: {
      step: explainStep,
      result: explainResult,
      text: explainText,
      warning: explainWarning,
      source: explainSource,
      error: explainError,
    },
    draft: {
      step: draftStep,
      result: draftResult,
      text: draftText,
      warning: draftWarning,
      source: draftSource,
      error: draftError,
    },
  } as const;

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
    // Explain / Draft / cloud offers need ready/done and never run while another step is busy
    // (no cloud send from `redacting`, `awaiting_consent` or `cloud_running`).
    const ready = docReady();
    explainBtn.disabled = !ready;
    draftBtn.disabled = !ready;
    explainCloudBtn.disabled = !ready;
    draftCloudBtn.disabled = !ready;
    cloudGateBtn.disabled = !ready;
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

  function resetAction(action: Action): void {
    if (action === "explain") resetExplain();
    else resetDraft();
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
    preflight.textContent = check.ok
      ? `Pre-flight OK: ${preflightLine(check)}`
      : `Pre-flight on the redacted text: ${preflightLine(check)}`;
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

  // ---------------------------------------------------------------- router (ARCHITECTURE 3.6)

  /** Router input for an action on the current document. Lengths only; no text leaves here. */
  async function route(
    action: Action,
    flags: { userRequestedCloud?: boolean; onDeviceFailed?: boolean },
  ): Promise<RouteDecision> {
    const raw = currentRaw ?? "";
    const redacted = currentMasked ?? "";
    const nanoAvailable = await nanoIsAvailable();
    if (action === "explain") {
      // On-device explain reads the RAW text (it never leaves the device).
      return decideRoute({
        redactedChars: redacted.length,
        rawChars: raw.length,
        question: "",
        overheadChars: buildExplainPrompt("").length,
        nanoAvailable,
        ...flags,
      });
    }
    const instruction = normalizeDraftInstruction(draftInstruction.value);
    return decideRoute({
      redactedChars: redacted.length,
      question: instruction,
      overheadChars: buildDraftPrompt("", instruction).length - instruction.length,
      nanoAvailable,
      ...flags,
    });
  }

  // ------------------------------------------------------------ consent gate (ARCHITECTURE 5)

  function openConsent(action: Action, reasons: readonly RouteReason[], ctx: {
    estimatedTokens?: number;
    hardQuestion?: readonly HardQuestionFamily[];
  }): void {
    const redacted = currentMasked;
    const map = currentMap;
    if (redacted === null || map === null) return;
    lastAction = action;

    // Build the payload ONCE from the redacted document + instruction + prompt boilerplate.
    const payload = buildCloudPayload(
      redacted,
      action === "explain" ? { kind: "explain" } : { kind: "draft", instruction: draftInstruction.value },
    );
    pending = { action, payload, map, runId };

    consentReasons.replaceChildren(
      ...reasons.map((r) => {
        const li = document.createElement("li");
        li.textContent = reasonLine(r, ctx);
        return li;
      }),
    );
    consentChars.textContent = payload.text.length.toLocaleString("en-US");
    consentPreview.textContent = payload.text; // the exact outgoing string
    consentPreview.scrollTop = 0;
    // Gate decision on the exact payload: pre-flight AND no placeholder-map original left in it.
    const gate = checkCloudSend(payload.text, map);
    consentCounts.textContent = consentCountsLine(summarizeMasked(map), gate.preflight);
    consentCounts.classList.toggle("error", !gate.ok);

    // Send is enabled only with zero blocking hits, zero map leaks, AND Firebase / App Check initialized.
    const blocked: string[] = [];
    if (!gate.preflight.ok) blocked.push(preflightLine(gate.preflight));
    if (gate.leaks.length > 0) blocked.push(leakLine(gate.leaks));
    if (!isFirebaseInitialized()) {
      blocked.push("Firebase / App Check is not initialized (see Status), so the cloud cannot be used. Nothing will be sent.");
    }
    consentBlocked.textContent = blocked.join("\n");
    consentBlocked.hidden = blocked.length === 0;
    consentSend.disabled = blocked.length > 0;

    setState("awaiting_consent");
    deps.setPendingConsent(true);
    ui[action].step.textContent = "Waiting for your decision in the consent dialog...";
    if (!dialog.open) dialog.showModal();
    consentCancel.focus(); // Cancel is the default action.
  }

  /** Cancel / Escape: stay on-device (ARCHITECTURE 4.2 last line). */
  function onConsentDismissed(): void {
    const p = pending;
    if (!p) return;
    pending = null;
    deps.setPendingConsent(false);
    ui[p.action].step.textContent = cancelLine(p.action);
    setState("ready");
  }

  /**
   * The ONLY place that calls the cloud. Runs from the Send button's click (the user gesture),
   * re-checks pre-flight on the exact previewed string, then sends that same string.
   */
  async function onConsentSend(): Promise<void> {
    const p = pending;
    if (!p || state !== "awaiting_consent" || consentSend.disabled) return;
    if (p.runId !== runId || !isFirebaseInitialized()) {
      dialog.close("cancel");
      return;
    }
    // Defense in depth: pre-flight + map-leak check again, immediately before the call.
    try {
      assertPreflight(p.payload.text);
      assertNoMapLeaks(p.payload.text, p.map);
    } catch (err) {
      consentSend.disabled = true;
      consentBlocked.textContent =
        err instanceof PreflightError
          ? preflightLine({ ok: false, hits: err.hits })
          : err instanceof MapLeakError
            ? leakLine(err.hits)
            : "Pre-flight failed. Nothing was sent.";
      consentBlocked.hidden = false;
      return;
    }

    pending = null; // so the dialog's close event does not count as Cancel
    dialog.close("send");
    const out = ui[p.action];
    resetAction(p.action);
    setState("cloud_running");
    out.step.textContent = "Sending the redacted text to Firebase AI Logic (ONLY_IN_CLOUD, streaming). Placeholders are filled in locally when it finishes...";
    out.result.hidden = false;
    try {
      const { text, inferenceSource } = await generateInCloudStream(p.payload.text, (chunk) => {
        out.text.textContent += chunk;
      });
      deps.setPrivacy(cloudStatusLine(p.payload.text.length));
      if (p.runId !== runId) {
        deps.setPendingConsent(false);
        return;
      }
      // Unmask LOCALLY with the in-memory map; the map never went into the request.
      const result = unmask(text, p.map);
      out.text.textContent = result.text;
      if (result.suspects > 0) {
        out.warning.textContent = `Hid ${result.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
        out.warning.hidden = false;
      }
      if (p.action === "draft") {
        lastDraft = result.text;
        draftCopyBtn.hidden = lastDraft.length === 0;
      }
      out.source.textContent = inferenceSource;
      deps.setBadge(inferenceSource);
      out.step.textContent = p.action === "draft" ? "Done. Review the draft before sending it." : "Done.";
      setState("done");
    } catch (err) {
      if (!(err instanceof PreflightError)) {
        deps.setPrivacy(
          `Tried to send ${p.payload.text.length.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud); the request failed. The placeholder map stayed here.`,
        );
      }
      deps.setPendingConsent(false);
      if (p.runId !== runId) return;
      out.text.textContent = "";
      out.result.hidden = true;
      if (p.action === "draft") {
        lastDraft = "";
        draftCopyBtn.hidden = true;
      }
      out.step.textContent = "Failed.";
      out.error.textContent = `Cloud request failed (${errLabel(err)}). The placeholder map stayed on this device.`;
      out.error.hidden = false;
      setState("error");
      setState("ready");
    }
  }

  /** Opens the gate for an action via the router with userRequestedCloud (never sends). */
  async function offerCloud(action: Action, flags: { userRequestedCloud?: boolean; onDeviceFailed?: boolean }): Promise<void> {
    const myRun = runId;
    const decision = await route(action, flags);
    if (myRun !== runId || pending) return;
    if (decision.route === "offer_cloud") {
      openConsent(action, decision.reasons, decision);
    }
  }

  async function onDeeper(action: Action): Promise<void> {
    if (!docReady()) return;
    resetAction(action);
    await offerCloud(action, { userRequestedCloud: true });
  }

  // ----------------------------------------------------------------------- explain / draft

  /** On-device failure: show the error, then OFFER the gate. Nothing is sent automatically. */
  async function onDeviceFailure(action: Action, myRun: number, message: string): Promise<void> {
    if (myRun !== runId) return;
    const out = ui[action];
    if (action === "draft") {
      lastDraft = "";
      draftCopyBtn.hidden = true;
    }
    // Never show partial output from a failed or refused call.
    out.text.textContent = "";
    out.result.hidden = true;
    out.step.textContent = "Failed.";
    out.error.textContent = `${message} Nothing was sent to the cloud; there is no automatic cloud fallback.`;
    out.error.hidden = false;
    setState("error");
    setState("ready");
    await offerCloud(action, { onDeviceFailed: true });
  }

  async function onExplain(): Promise<void> {
    if (!docReady()) return;
    const raw = currentRaw;
    const map = currentMap;
    if (raw === null || map === null) return;
    const myRun = runId;
    lastAction = "explain";
    resetExplain();
    if (!isFirebaseInitialized()) {
      explainStep.textContent = "Explain unavailable: Firebase is not initialized (see Status). Nothing was sent anywhere.";
      return;
    }

    setState("explaining");
    explainStep.textContent = "Checking whether this fits on-device...";
    const decision = await route("explain", {});
    if (myRun !== runId) return;
    if (decision.route === "offer_cloud") {
      setState("ready");
      openConsent("explain", decision.reasons, decision);
      return;
    }

    try {
      explainStep.textContent = "Preparing Gemini Nano...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      explainStep.textContent = "Explaining on-device (ONLY_ON_DEVICE, streaming)...";
      explainResult.hidden = false;
      const { text, inferenceSource } = await generateOnDeviceStream(buildExplainPrompt(raw), (chunk) => {
        explainText.textContent += chunk;
      });
      if (myRun !== runId) return;
      if (!text.trim()) {
        await onDeviceFailure("explain", myRun, "On-device explain returned an empty answer.");
        return;
      }
      // Keep suspect-PII handling consistent with the cloud path (usually a no-op here).
      const out = unmask(text, map);
      explainText.textContent = out.text;
      if (out.suspects > 0) {
        explainWarning.textContent = `Hid ${out.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
        explainWarning.hidden = false;
      }
      explainSource.textContent = inferenceSource;
      deps.setBadge(inferenceSource);
      if (inferenceSource === InferenceSource.ON_DEVICE) deps.setPrivacy(NOTHING_LEFT);
      explainStep.textContent = "Done.";
      setState("done");
    } catch (err) {
      await onDeviceFailure("explain", myRun, `On-device explain failed (${errLabel(err)}).`);
    }
  }

  async function onDraft(): Promise<void> {
    if (!docReady()) return;
    const redacted = currentMasked;
    const map = currentMap;
    if (redacted === null || map === null) return;
    const myRun = runId;
    lastAction = "draft";
    const instruction = draftInstruction.value;
    resetDraft();
    if (!isFirebaseInitialized()) {
      draftStep.textContent = "Draft unavailable: Firebase is not initialized (see Status). Nothing was sent anywhere.";
      return;
    }

    setState("drafting");
    draftStep.textContent = "Checking whether this fits on-device...";
    const decision = await route("draft", {});
    if (myRun !== runId) return;
    if (decision.route === "offer_cloud") {
      setState("ready");
      openConsent("draft", decision.reasons, decision);
      return;
    }

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
        // The router already checked the budget; keep this as a consistent offer, never a send.
        draftText.textContent = "";
        draftResult.hidden = true;
        draftStep.textContent = outcome.message;
        setState("ready");
        await offerCloud("draft", {});
        return;
      }
      if (!outcome.text.trim()) {
        await onDeviceFailure("draft", myRun, "On-device draft returned an empty answer.");
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
      if (outcome.inferenceSource === InferenceSource.ON_DEVICE) deps.setPrivacy(NOTHING_LEFT);
      draftCopyBtn.hidden = lastDraft.length === 0;
      draftStep.textContent = "Done. Review the draft before sending it.";
      setState("done");
    } catch (err) {
      await onDeviceFailure("draft", myRun, `On-device draft failed (${errLabel(err)}).`);
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
  explainCloudBtn.addEventListener("click", () => {
    void onDeeper("explain");
  });
  draftCloudBtn.addEventListener("click", () => {
    void onDeeper("draft");
  });
  // Header ☁️ on a ready document opens the same gate (ARCHITECTURE 5); it never sends directly.
  cloudGateBtn.addEventListener("click", () => {
    void onDeeper(lastAction);
  });
  consentCancel.addEventListener("click", () => {
    dialog.close("cancel");
  });
  consentSend.addEventListener("click", () => {
    void onConsentSend();
  });
  // Escape (native "cancel") and any other close path count as Cancel unless Send cleared `pending`.
  dialog.addEventListener("close", onConsentDismissed);
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
