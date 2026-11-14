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
  EntityPassIncompleteError,
  InferenceSource,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  MapLeakError,
  PreflightError,
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
  redactWithMap,
  startDeviceModel,
  summarizeMasked,
  unmask,
  type CloudPayload,
  type Detection,
  type EntityPassStatus,
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
  SEND_LABEL,
  STREAMING_LABEL,
  cancelLine,
  cloudEmptyLine,
  cloudStatusLine,
  consentCountsLine,
  entityPassBlockedLine,
  incompleteStepLine,
  instructionPassBlockedLine,
  leakLine,
  onDevicePrivacyLine,
  preflightLine,
  reasonLine,
} from "../lib/consentCopy";
import { sendToCloudGuarded } from "../lib/cloudSend";
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

const INSTRUCTION_CHANGED =
  "The instruction changed after this draft was written, so Copy draft is off. Click Draft reply again for a draft that follows it.";

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
/**
 * On-device entity-pass status for currentRaw. Cloud send requires "complete"; every new
 * redaction, New document, capture or text edit resets it to "pending".
 */
let currentEntityPass: EntityPassStatus = "pending";
/** Last unmasked draft, for the Copy button. Panel memory only. */
let lastDraft = "";
/** Normalized instruction the shown draft was written for (Copy is withdrawn when it changes). */
let lastDraftInstruction = "";
/** Last action the user started; the header cloud button opens the gate for it. */
let lastAction: Action = "explain";
/** Bumped on every Redact / New document / capture so stale async work cannot overwrite newer state. */
let runId = 0;
/**
 * Bumped whenever an Explain / Draft / cloud-offer operation starts. An async step may only open
 * the consent dialog or publish a result if it still owns this token (Codex 8).
 */
let actionToken = 0;
/** Characters of redacted text sent to the cloud for the CURRENT document (New document resets). */
let docSentChars = 0;
/** Characters of redacted text sent to the cloud during this panel session (never reset). */
let sessionSentChars = 0;

/** For the footer of other on-device features (main.ts): was anything sent this session? */
export function sessionCloudSentChars(): number {
  return sessionSentChars;
}

interface PendingConsent {
  action: Action;
  /** Built once; shown verbatim in the preview; this same object's text is what Send sends. */
  payload: CloudPayload;
  /** Document map, extended with the draft instruction's entries when one is included. */
  map: PlaceholderMap;
  runId: number;
  /** Raw text the payload was derived from (stale-result check after the call). */
  raw: string;
  /** Normalized (unmasked) draft instruction the payload was built for ("" for explain / none). */
  instruction: string;
  /** Entity-pass status when the dialog opened (re-checked against the current one on Send). */
  entityPass: EntityPassStatus;
  /** On-device entity pass over the draft instruction, or "not_needed" when there is none. */
  instructionPass: EntityPassStatus | "not_needed";
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
    explainText.classList.remove("provisional");
    explainSource.textContent = "";
    explainWarning.textContent = "";
    explainWarning.hidden = true;
    explainResult.hidden = true;
    explainError.textContent = "";
    explainError.hidden = true;
  }

  function resetDraft(): void {
    lastDraft = "";
    lastDraftInstruction = "";
    draftStep.textContent = "";
    draftText.textContent = "";
    draftText.classList.remove("provisional");
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

  /**
   * Enters the action's busy state SYNCHRONOUSLY (before any await), so no other action can start
   * while routing / probing runs, and returns the ownership token (Codex 8).
   */
  function beginAction(action: Action): number {
    const token = ++actionToken;
    lastAction = action;
    setState(action === "explain" ? "explaining" : "drafting");
    return token;
  }

  /** True while `token` / `myRun` still own the panel (no newer action, document, or capture). */
  function owns(token: number, myRun: number): boolean {
    return token === actionToken && myRun === runId;
  }

  /** Footer line after an on-device result: honest about earlier cloud sends (Codex 9). */
  function setOnDevicePrivacy(): void {
    deps.setPrivacy(onDevicePrivacyLine(docSentChars, sessionSentChars));
  }

  /** Records that a redacted request of `chars` characters went out to the cloud. */
  function recordCloudSend(chars: number): void {
    docSentChars += chars;
    sessionSentChars += chars;
  }

  /** The text changed while a result was being produced: never show it as current (Codex 10). */
  function discardStale(action: Action): void {
    resetAction(action);
    ui[action].step.textContent = "The text changed while this was running, so the result was discarded. Click Redact again.";
    setState("ready");
  }

  /** Marks streamed-in text as provisional until it is validated and unmasked (Codex 12). */
  function showStreaming(action: Action): void {
    const out = ui[action];
    out.text.textContent = "";
    out.text.classList.add("provisional");
    out.source.textContent = STREAMING_LABEL;
    out.result.hidden = false;
  }

  function endStreaming(action: Action): void {
    ui[action].text.classList.remove("provisional");
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

  async function storeMap(
    map: PlaceholderMap,
    previousDocId: string | undefined,
    entityPass: EntityPassStatus,
  ): Promise<void> {
    try {
      if (previousDocId && previousDocId !== map.docId) await clearMap(previousDocId);
      await saveMap(map, entityPass);
      status.textContent = `Placeholder map kept in session storage only (${map.entries.length} entries).`;
    } catch (err) {
      status.textContent = `Could not save placeholder map to session storage: ${err instanceof Error ? err.name : "error"}.`;
    }
  }

  /**
   * Runs the ONLY_ON_DEVICE entity pass on the whole document. `result` is null (with a visible
   * note) when skipped or failed. `status` is "complete" only when the pass ran on-device and its
   * output parsed; any other outcome blocks cloud send.
   */
  async function runLlmPass(
    raw: string,
    docId: string,
    myRun: number,
  ): Promise<{ result: RedactResult | null; status: EntityPassStatus }> {
    if (raw.length > LLM_EXTRACT_MAX_CHARS) {
      llmNote.textContent = `${LLM_SKIPPED_TOO_LONG_NOTE}. Showing regex-only redaction.`;
      return { result: null, status: "skipped_too_long" };
    }
    if (!isFirebaseInitialized()) {
      llmNote.textContent = "On-device entity pass unavailable: Firebase is not initialized (see Status). Showing regex-only redaction.";
      return { result: null, status: "unavailable" };
    }
    let availability = "unavailable";
    try {
      availability = await probeNano();
    } catch {
      // treat as unavailable
    }
    if (availability === "unavailable") {
      llmNote.textContent = "Gemini Nano is unavailable on this device, so names/organizations/addresses were not extracted. Showing regex-only redaction. Nothing was sent to the cloud.";
      return { result: null, status: "unavailable" };
    }
    try {
      llmNote.textContent =
        availability === "available"
          ? "Running on-device entity pass (Gemini Nano)..."
          : "Preparing Gemini Nano (first run downloads the model; progress shown in the On-device card)...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      deps.refreshNano();
      if (myRun !== runId) return { result: null, status: "pending" };
      llmNote.textContent = "Running on-device entity pass (Gemini Nano)...";
      const { detections, warnings, ok } = await extractEntitiesOnDevice(raw);
      if (myRun !== runId) return { result: null, status: "pending" };
      const result = redactWithLlm(raw, detections, { docId });
      const extra = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
      llmNote.textContent = `On-device entity pass added ${detections.length} verified span(s) before merging.${extra}`;
      return { result, status: ok ? "complete" : "failed" };
    } catch (err) {
      if (myRun === runId) {
        llmNote.textContent = `On-device entity pass failed (${errLabel(err)}). Showing regex-only redaction. Nothing was sent to the cloud.`;
      }
      return { result: null, status: "failed" };
    }
  }

  async function onRedact(): Promise<void> {
    if (BUSY_STATES.has(state)) return;
    const myRun = ++runId;
    status.textContent = "";
    resetExplain();
    resetDraft();
    const raw = input.value;
    currentEntityPass = "pending"; // until the pass completes for THIS text
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
    await storeMap(base.map, previousDocId, "pending");
    if (myRun !== runId) return;

    // 2. On-device LLM pass (same docId so the stored map is replaced, not duplicated).
    const { result: withLlm, status: entityPass } = await runLlmPass(raw, base.map.docId, myRun);
    if (myRun !== runId) return;
    if (withLlm) {
      currentMap = withLlm.map;
      currentMasked = withLlm.masked;
      renderRedaction(withLlm);
    }
    currentEntityPass = entityPass;
    await storeMap(withLlm ? withLlm.map : base.map, undefined, entityPass);
    if (myRun !== runId) return;
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

  /**
   * Codex 3: a draft instruction that goes to the cloud gets its own ONLY_ON_DEVICE entity pass,
   * then is masked against the document map (known originals reuse their tokens; new names /
   * addresses / emails get new tokens). Deterministic identifiers (emails etc.) are MASKED here
   * rather than only blocked by pre-flight. `status` is "complete" only when the pass ran
   * on-device and its output was schema-valid; anything else blocks Send.
   */
  async function prepareInstruction(
    instruction: string,
    map: PlaceholderMap,
  ): Promise<{ masked: string; map: PlaceholderMap; status: EntityPassStatus }> {
    let detections: Detection[] = [];
    let status: EntityPassStatus = "unavailable";
    if (isFirebaseInitialized()) {
      let availability = "unavailable";
      try {
        availability = await probeNano();
      } catch {
        // treat as unavailable
      }
      if (availability !== "unavailable") {
        try {
          await startDeviceModel(deps.setProgress);
          const r = await extractEntitiesOnDevice(instruction);
          detections = r.detections;
          status = r.ok ? "complete" : "failed";
        } catch {
          status = "failed";
        }
      }
    }
    const red = redactWithMap(instruction, detections, map, { reservedTexts: [currentRaw ?? ""] });
    return { masked: red.masked, map: red.map, status };
  }

  /**
   * Builds the exact payload, renders the gate and opens it. Must be called while the action's
   * busy state is held by `token`; it re-checks ownership after every await and only then opens
   * the dialog. Returns without touching the UI when ownership was lost.
   */
  async function openConsent(
    action: Action,
    reasons: readonly RouteReason[],
    ctx: { estimatedTokens?: number; hardQuestion?: readonly HardQuestionFamily[] },
    token: number,
    myRun: number,
  ): Promise<void> {
    const redacted = currentMasked;
    const docMap = currentMap;
    const raw = currentRaw;
    if (redacted === null || docMap === null || raw === null || pending) {
      if (owns(token, myRun)) setState("ready");
      return;
    }
    lastAction = action;

    let map = docMap;
    let instruction = "";
    let maskedInstruction = "";
    let instructionPass: EntityPassStatus | "not_needed" = "not_needed";
    if (action === "draft") {
      instruction = normalizeDraftInstruction(draftInstruction.value);
      if (instruction) {
        ui.draft.step.textContent = "Checking your instruction for names and addresses on this device...";
        const prepared = await prepareInstruction(instruction, docMap);
        if (!owns(token, myRun)) return;
        map = prepared.map;
        maskedInstruction = prepared.masked;
        instructionPass = prepared.status;
      }
    }

    // Build the payload ONCE from the redacted document + (masked) instruction + boilerplate.
    const payload = buildCloudPayload(
      redacted,
      action === "explain" ? { kind: "explain" } : { kind: "draft", instruction: maskedInstruction },
    );
    pending = { action, payload, map, runId: myRun, raw, instruction, entityPass: currentEntityPass, instructionPass };

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
    // Gate decision on the exact payload: entity pass complete AND pre-flight AND no
    // placeholder-map original left in it.
    const gate = checkCloudSend(payload.text, map, currentEntityPass);
    consentCounts.textContent = consentCountsLine(summarizeMasked(map), gate.preflight);
    consentCounts.classList.toggle("error", !gate.ok);

    // Send is enabled only with a completed on-device entity pass, zero blocking hits, zero map
    // leaks, AND Firebase / App Check initialized.
    const blocked: string[] = [];
    if (gate.reasons.includes("entity_pass_incomplete")) blocked.push(entityPassBlockedLine(gate.entityPass));
    const instructionBlock = instructionPassBlockedLine(instructionPass);
    if (instructionBlock) blocked.push(instructionBlock);
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
    // Defense in depth, immediately before the call: entity pass complete (for the document as it
    // is NOW, not just when the dialog opened) + pre-flight + map-leak check, all inside
    // sendToCloudGuarded. The cloud is only reached through its injected `generate`.
    const entityPass: EntityPassStatus = p.entityPass === "complete" ? currentEntityPass : p.entityPass;
    const out = ui[p.action];
    let started = false;
    try {
      const { text, inferenceSource, complete, finishReason } = await sendToCloudGuarded(
        { payload: p.payload.text, map: p.map, entityPass, instructionPass: p.instructionPass },
        (payloadText) => {
          started = true;
          pending = null; // so the dialog's close event does not count as Cancel
          recordCloudSend(payloadText.length);
          dialog.close("send");
          resetAction(p.action);
          setState("cloud_running");
          out.step.textContent = "Sending the redacted text to Firebase AI Logic (ONLY_IN_CLOUD, streaming). Placeholders are filled in locally when it finishes...";
          showStreaming(p.action);
          return generateInCloudStream(payloadText, (chunk) => {
            out.text.textContent += chunk;
          });
        },
      );
      endStreaming(p.action);
      if (!text.trim()) {
        // Codex 13: the request WAS sent, but there is no answer. Never "Done.".
        deps.setPrivacy(cloudEmptyLine(p.payload.text.length));
        deps.setPendingConsent(false);
        if (p.runId !== runId) return;
        resetAction(p.action);
        out.step.textContent = "Failed.";
        out.error.textContent = "The cloud returned an empty answer. Your redacted request was sent, but nothing came back. The placeholder map stayed on this device.";
        out.error.hidden = false;
        setState("error");
        setState("ready");
        return;
      }
      deps.setPrivacy(cloudStatusLine(p.payload.text.length));
      if (p.runId !== runId) {
        deps.setPendingConsent(false);
        return;
      }
      if (input.value !== p.raw) {
        deps.setPendingConsent(false);
        discardStale(p.action);
        return;
      }
      // Unmask LOCALLY with the in-memory map; the map never went into the request.
      const result = unmask(text, p.map);
      out.text.textContent = result.text;
      if (result.suspects > 0) {
        out.warning.textContent = `Hid ${result.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
        out.warning.hidden = false;
      }
      out.source.textContent = inferenceSource;
      deps.setBadge(inferenceSource);
      if (!complete) {
        // Codex 15: partial answer (truncated / blocked / finish reason not reported).
        out.step.textContent = incompleteStepLine(finishReason);
        setState("done");
        return;
      }
      if (p.action === "draft") {
        lastDraft = result.text;
        lastDraftInstruction = p.instruction;
      }
      out.step.textContent = p.action === "draft" ? "Done. Review the draft before sending it." : "Done.";
      if (p.action === "draft" && normalizeDraftInstruction(draftInstruction.value) !== p.instruction) {
        lastDraft = "";
        out.step.textContent = INSTRUCTION_CHANGED;
      }
      if (p.action === "draft") draftCopyBtn.hidden = lastDraft.length === 0;
      setState("done");
    } catch (err) {
      endStreaming(p.action);
      if (!started) {
        // A pre-send check refused: nothing was sent. Keep the dialog open with Send disabled.
        consentSend.disabled = true;
        consentBlocked.textContent =
          err instanceof EntityPassIncompleteError
            ? err.scope === "instruction"
              ? instructionPassBlockedLine(err.status)
              : entityPassBlockedLine(err.status)
            : err instanceof PreflightError
              ? preflightLine({ ok: false, hits: err.hits })
              : err instanceof MapLeakError
                ? leakLine(err.hits)
                : "Pre-flight failed. Nothing was sent.";
        consentBlocked.hidden = false;
        return;
      }
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

  /**
   * Routes and, if the router offers the cloud, opens the gate (never sends). Enters the action's
   * busy state synchronously before the availability probe, so nothing else can start meanwhile,
   * and opens the dialog only if it still owns the panel afterwards (Codex 8).
   */
  async function offerCloud(action: Action, flags: { userRequestedCloud?: boolean; onDeviceFailed?: boolean }): Promise<void> {
    const myRun = runId;
    const token = beginAction(action);
    try {
      const decision = await route(action, flags);
      if (!owns(token, myRun) || pending) return;
      if (decision.route === "offer_cloud") {
        await openConsent(action, decision.reasons, decision, token, myRun);
        return;
      }
      setState("ready");
    } catch (err) {
      if (!owns(token, myRun)) return;
      ui[action].step.textContent = `Could not open the cloud review (${errLabel(err)}). Nothing was sent.`;
      setState("ready");
    }
  }

  async function onDeeper(action: Action): Promise<void> {
    if (!docReady()) return;
    resetAction(action);
    ui[action].step.textContent = "Preparing the redacted copy for review...";
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
    out.text.classList.remove("provisional");
    out.step.textContent = "Failed.";
    out.error.textContent = `${message} Nothing was sent to the cloud; there is no automatic cloud fallback.`;
    out.error.hidden = false;
    setState("error");
    // offerCloud re-enters a busy state synchronously (no window for another action to start).
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

    const token = beginAction("explain");
    explainStep.textContent = "Checking whether this fits on-device...";
    const decision = await route("explain", {});
    if (!owns(token, myRun)) return;
    if (decision.route === "offer_cloud") {
      await openConsent("explain", decision.reasons, decision, token, myRun);
      return;
    }

    try {
      explainStep.textContent = "Preparing Gemini Nano...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      explainStep.textContent = "Explaining on-device (ONLY_ON_DEVICE, streaming)...";
      showStreaming("explain");
      const { text, inferenceSource } = await generateOnDeviceStream(buildExplainPrompt(raw), (chunk) => {
        explainText.textContent += chunk;
      });
      if (!owns(token, myRun)) return;
      endStreaming("explain");
      if (!text.trim()) {
        await onDeviceFailure("explain", myRun, "On-device explain returned an empty answer.");
        return;
      }
      if (input.value !== raw) {
        discardStale("explain");
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
      if (inferenceSource === InferenceSource.ON_DEVICE) setOnDevicePrivacy();
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
    const rawAtStart = currentRaw;
    resetDraft();
    if (!isFirebaseInitialized()) {
      draftStep.textContent = "Draft unavailable: Firebase is not initialized (see Status). Nothing was sent anywhere.";
      return;
    }

    const token = beginAction("draft");
    draftStep.textContent = "Checking whether this fits on-device...";
    const decision = await route("draft", {});
    if (!owns(token, myRun)) return;
    if (decision.route === "offer_cloud") {
      await openConsent("draft", decision.reasons, decision, token, myRun);
      return;
    }

    try {
      draftStep.textContent = "Preparing Gemini Nano...";
      await startDeviceModel(deps.setProgress);
      deps.setProgress(100);
      draftStep.textContent =
        "Drafting on-device from the redacted text (ONLY_ON_DEVICE, streaming). Placeholders are filled in locally when it finishes...";
      showStreaming("draft");
      const outcome = await draftReplyOnDevice(redacted, instruction, (chunk) => {
        draftText.textContent += chunk;
      });
      if (!owns(token, myRun)) return;
      endStreaming("draft");
      if (outcome.kind === "too_long") {
        // The router already checked the budget; keep this as a consistent offer, never a send.
        draftText.textContent = "";
        draftResult.hidden = true;
        draftStep.textContent = outcome.message;
        await offerCloud("draft", {});
        return;
      }
      if (!outcome.text.trim()) {
        await onDeviceFailure("draft", myRun, "On-device draft returned an empty answer.");
        return;
      }
      if (input.value !== rawAtStart) {
        discardStale("draft");
        return;
      }
      // Unmask LOCALLY with the in-memory map; the map never went into the prompt.
      const out = unmask(outcome.text, map);
      draftText.textContent = out.text;
      lastDraft = out.text;
      lastDraftInstruction = normalizeDraftInstruction(instruction);
      if (out.suspects > 0) {
        draftWarning.textContent = `Hid ${out.suspects} identifier(s) in the draft that did not come from your document's placeholder map.`;
        draftWarning.hidden = false;
      }
      draftSource.textContent = outcome.inferenceSource;
      deps.setBadge(outcome.inferenceSource);
      if (outcome.inferenceSource === InferenceSource.ON_DEVICE) setOnDevicePrivacy();
      draftStep.textContent = "Done. Review the draft before sending it.";
      if (normalizeDraftInstruction(draftInstruction.value) !== lastDraftInstruction) {
        lastDraft = "";
        draftStep.textContent = INSTRUCTION_CHANGED;
      }
      draftCopyBtn.hidden = lastDraft.length === 0;
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
    currentEntityPass = "pending";
    docSentChars = 0; // per-document cloud disclosure starts over; the session total stays
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
    if (input.value !== currentRaw && currentEntityPass !== "pending") {
      // The entity pass no longer covers the text: block cloud send until a new Redact completes.
      currentEntityPass = "pending";
      if (currentMap) void storeMap(currentMap, undefined, "pending");
    }
    setState(state);
    if (hadDoc && input.value !== currentRaw) {
      // Codex 10: results (and Copy draft) for the old text must not stay usable.
      resetExplain();
      resetDraft();
      explainStep.textContent = "Text changed. Click Redact again before explaining.";
      draftStep.textContent = "Text changed. Click Redact again before drafting.";
    } else if (hadDoc) {
      explainStep.textContent = "";
      draftStep.textContent = "";
    }
    // While busy, in-flight results are checked against the text when they finish (discardStale).
  });
  draftInstruction.addEventListener("input", () => {
    // Codex 10: a shown draft no longer matches a changed instruction: withdraw Copy draft.
    if (BUSY_STATES.has(state) || !lastDraft) return;
    if (normalizeDraftInstruction(draftInstruction.value) === lastDraftInstruction) return;
    lastDraft = "";
    draftCopyBtn.hidden = true;
    draftStep.textContent = INSTRUCTION_CHANGED;
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
