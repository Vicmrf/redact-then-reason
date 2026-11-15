// Redact-then-Reason — hosted paste-text demo.
//
// Same engine as the Chrome extension (@rtr/core), same privacy rule: on-device by default,
// the cloud only ever receives a redacted copy and only after an explicit consent click.
//   paste / load sample -> Redact (deterministic preview, then on-device entity pass)
//      If Gemini Nano is unavailable, errors, or does not finish within a time limit, the demo
//      proceeds with deterministic-only redaction (regex + Luhn) and says so honestly; Send then
//      depends on the deterministic pre-flight + map-leak checks, which are never bypassed.
//   -> Explain / Draft on-device (ONLY_ON_DEVICE), OR
//   -> router offers the cloud -> consent gate shows the EXACT redacted payload -> Send
//      runs ONLY_IN_CLOUD on that string, after pre-flight + map-leak + entity-pass checks.
// All text is rendered with textContent. Never innerHTML. The placeholder map never leaves
// this page and is never sent to the cloud.
import {
  EntityPassIncompleteError,
  InferenceSource,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  MapLeakError,
  PreflightError,
  FirebaseNotConfiguredError,
  assertNoMapLeaks,
  assertPreflight,
  buildCloudPayload,
  buildDraftPrompt,
  buildExplainPrompt,
  checkCloudSend,
  decideRoute,
  draftReplyOnDevice,
  extractEntitiesOnDevice,
  generateInCloudStream,
  generateOnDeviceStream,
  initFirebase,
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
} from "@rtr/core";
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
  deterministicOnlyConsentLine,
  deterministicOnlyPanelLine,
  type DeterministicOnlyCause,
  entityPassBlockedLine,
  incompleteStepLine,
  instructionPassBlockedLine,
  leakLine,
  onDevicePrivacyLine,
  preflightLine,
  reasonLine,
} from "./copy";
import { renderCountChips, renderMaskedChips } from "./chips";
import { SAMPLES } from "./samples";

type Action = "explain" | "draft";
type PanelState =
  | "idle" | "redacting" | "ready" | "explaining" | "drafting"
  | "awaiting_consent" | "cloud_running" | "done" | "error";

const NO_IDENTIFIERS = "No identifiers detected.";
const INSTRUCTION_CHANGED =
  "The instruction changed after this draft was written, so Copy draft is off. Click Draft reply again for a draft that follows it.";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in demo markup`);
  return node as T;
}

const ui = {
  badge: byId("badge"),
  cloudGateBtn: byId<HTMLButtonElement>("cloud-gate-btn"),
  configBanner: byId("config-banner"),

  sampleSelect: byId<HTMLSelectElement>("sample-select"),
  input: byId<HTMLTextAreaElement>("redact-input"),
  newDocBtn: byId<HTMLButtonElement>("newdoc-btn"),

  draftInstruction: byId<HTMLInputElement>("draft-instruction"),
  redactBtn: byId<HTMLButtonElement>("redact-btn"),
  explainBtn: byId<HTMLButtonElement>("explain-btn"),
  draftBtn: byId<HTMLButtonElement>("draft-btn"),
  explainCloudBtn: byId<HTMLButtonElement>("explain-cloud-btn"),
  draftCloudBtn: byId<HTMLButtonElement>("draft-cloud-btn"),

  status: byId("redact-status"),
  llmNote: byId("redact-llm-note"),
  progressWrap: byId("progress-wrap"),
  progress: byId<HTMLProgressElement>("progress"),
  progressLabel: byId("progress-label"),

  preview: byId("redact-preview"),
  masked: byId("redact-masked"),
  counts: byId("redact-counts"),
  preflight: byId("redact-preflight"),

  explainStep: byId("explain-step"),
  explainResult: byId("explain-result"),
  explainText: byId("explain-text"),
  explainWarning: byId("explain-warning"),
  explainSource: byId("explain-source"),
  explainError: byId("explain-error"),

  draftStep: byId("draft-step"),
  draftResult: byId("draft-result"),
  draftText: byId("draft-text"),
  draftWarning: byId("draft-warning"),
  draftSource: byId("draft-source"),
  draftCopyBtn: byId<HTMLButtonElement>("draft-copy-btn"),
  draftError: byId("draft-error"),

  privacy: byId("privacy"),
  firebaseStatus: byId("firebase-status"),
  nanoStatus: byId("nano-status"),
  debugTokenRow: byId("debug-token-row"),
  debugToken: byId("debug-token"),

  dialog: byId<HTMLDialogElement>("consent-dialog"),
  consentReasons: byId("consent-reasons"),
  consentChars: byId("consent-chars"),
  consentPreview: byId("consent-preview"),
  consentCounts: byId("consent-counts"),
  consentNote: byId("consent-note"),
  consentBlocked: byId("consent-blocked"),
  consentCancel: byId<HTMLButtonElement>("consent-cancel"),
  consentSend: byId<HTMLButtonElement>("consent-send"),
};

const out = {
  explain: { step: ui.explainStep, result: ui.explainResult, text: ui.explainText, warning: ui.explainWarning, source: ui.explainSource, error: ui.explainError },
  draft: { step: ui.draftStep, result: ui.draftResult, text: ui.draftText, warning: ui.draftWarning, source: ui.draftSource, error: ui.draftError },
} as const;

// ---------------------------------------------------------------- state
let state: PanelState = "idle";
let currentMap: PlaceholderMap | null = null;
let currentRaw: string | null = null;
let currentMasked: string | null = null;
let currentEntityPass: EntityPassStatus = "pending";
/** Why the entity pass is not "complete" when Send is allowed deterministic-only (demo copy only). */
let currentPassCause: DeterministicOnlyCause | null = null;
let lastDraft = "";
let lastDraftInstruction = "";
let lastAction: Action = "explain";
let runId = 0;
let actionToken = 0;
let sessionSentChars = 0;
let lastSource: string | null = null;

interface PendingConsent {
  action: Action;
  payload: CloudPayload;
  map: PlaceholderMap;
  runId: number;
  raw: string;
  instruction: string;
  entityPass: EntityPassStatus;
  instructionPass: EntityPassStatus | "not_needed";
  instructionCause: DeterministicOnlyCause | null;
}
let pending: PendingConsent | null = null;

const BUSY: ReadonlySet<PanelState> = new Set(["redacting", "explaining", "drafting", "awaiting_consent", "cloud_running"]);

// ---------------------------------------------------------------- deterministic-only fallback policy
// Hosted demo only (the extension keeps its strict "complete or blocked" gate).
// The deterministic detectors (regex + Luhn: emails, phones, SSNs, cards) ALWAYS run, and the
// pre-flight + map-leak checks ALWAYS gate Send on the exact previewed string. The Gemini Nano
// entity pass (names / orgs / addresses) is an enhancement: when it ran it must be "complete";
// when Nano is unavailable, failed, or timed out, Send is allowed on the deterministic-only copy
// with an explicit, non-blocking note in the consent dialog. "pending" (not run for the current
// text) and "skipped_too_long" (Nano present, doc too long for the extractor) still block.
const DETERMINISTIC_ONLY_OK: ReadonlySet<EntityPassStatus> = new Set<EntityPassStatus>(["unavailable", "failed"]);

function entityPassAllowsSend(status: EntityPassStatus): boolean {
  return status === "complete" || DETERMINISTIC_ONLY_OK.has(status);
}

function assertEntityPassAllowsSend(status: EntityPassStatus, scope: "document" | "instruction" = "document"): void {
  if (!entityPassAllowsSend(status)) throw new EntityPassIncompleteError(status, scope);
}

/** Time limits so a missing / slow Nano can never leave Send disabled forever. */
const NANO_PROBE_TIMEOUT_MS = 3_000;
const NANO_START_TIMEOUT_MS = 8_000;
const NANO_EXTRACT_TIMEOUT_MS = 20_000;

const TIMED_OUT: unique symbol = Symbol("timed_out");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function probeNanoWithTimeout(): Promise<string> {
  try {
    const r = await withTimeout(probeNano(), NANO_PROBE_TIMEOUT_MS);
    return r === TIMED_OUT ? "unavailable" : r;
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------- badge + progress
function setBadge(source: string): void {
  lastSource = source;
  ui.badge.classList.remove("badge--idle", "badge--device", "badge--cloud", "badge--unknown", "badge--pending");
  if (source === InferenceSource.ON_DEVICE) {
    ui.badge.textContent = "🔒 On-device";
    ui.badge.classList.add("badge--device");
  } else if (source === InferenceSource.IN_CLOUD) {
    ui.badge.textContent = "☁️ Cloud";
    ui.badge.classList.add("badge--cloud");
  } else {
    ui.badge.textContent = `Unknown source: ${source}`;
    ui.badge.classList.add("badge--unknown");
  }
}

function setPendingConsent(p: boolean): void {
  if (p) {
    ui.badge.classList.remove("badge--idle", "badge--device", "badge--cloud", "badge--unknown");
    ui.badge.textContent = "☁️ Pending consent";
    ui.badge.classList.add("badge--pending");
    return;
  }
  ui.badge.classList.remove("badge--pending");
  if (lastSource !== null) setBadge(lastSource);
  else {
    ui.badge.textContent = "No inference yet";
    ui.badge.classList.add("badge--idle");
  }
}

function setProgress(pct: number): void {
  ui.progressWrap.hidden = false;
  ui.progress.value = pct;
  ui.progressLabel.textContent = `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%`;
}

function setPrivacy(line: string): void {
  ui.privacy.textContent = line;
}

function errLabel(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
}

// ---------------------------------------------------------------- firebase boot
function boot(): void {
  try {
    const { appCheckMode } = initFirebase({ appCheck: "auto" });
    ui.firebaseStatus.textContent = `Initialized (App Check: ${appCheckMode} provider, then getAI with GoogleAIBackend).`;
    if (appCheckMode === "debug") {
      ui.configBanner.hidden = false;
      ui.configBanner.textContent =
        "Running with the App Check debug provider. On-device (🔒) features work here. For the consented cloud (☁️) path to work for anyone visiting this hosted demo, configure reCAPTCHA Enterprise (see the repo README) or register this browser's debug token below.";
      ui.debugTokenRow.hidden = false;
      const tok = self.FIREBASE_APPCHECK_DEBUG_TOKEN;
      ui.debugToken.textContent = typeof tok === "string" ? tok : "Open DevTools console and look for: AppCheck debug token: \"...\"";
    }
  } catch (err) {
    if (err instanceof FirebaseNotConfiguredError) {
      ui.firebaseStatus.textContent = err.message;
      ui.configBanner.hidden = false;
      ui.configBanner.textContent =
        "Firebase AI Logic is not fully configured for this hosted demo yet: the reCAPTCHA Enterprise App Check site key is missing, so the AI calls (on-device explain/draft and the consented cloud path) are disabled. The redaction preview below still works — paste a document and click Redact to see on-device-style PII masking. See the repo README for the one-time reCAPTCHA Enterprise setup.";
    } else {
      ui.firebaseStatus.textContent = `Initialization failed: ${errLabel(err)}`;
      ui.configBanner.hidden = false;
      ui.configBanner.textContent = `Firebase could not initialize: ${errLabel(err)}. The redaction preview still works; AI features are disabled.`;
    }
  }
  void refreshNano();
}

async function refreshNano(): Promise<void> {
  try {
    ui.nanoStatus.textContent = await probeNano();
  } catch (err) {
    ui.nanoStatus.textContent = `probe failed (${errLabel(err)})`;
  }
}

async function nanoIsAvailable(): Promise<boolean> {
  return (await probeNanoWithTimeout()) !== "unavailable";
}

// ---------------------------------------------------------------- state wiring
function docReady(): boolean {
  return (state === "ready" || state === "done") && currentRaw !== null && currentMasked !== null && ui.input.value === currentRaw;
}

function setState(next: PanelState): void {
  state = next;
  const busy = BUSY.has(next);
  ui.redactBtn.disabled = busy;
  ui.newDocBtn.disabled = busy;
  ui.sampleSelect.disabled = busy;
  const ready = docReady();
  ui.explainBtn.disabled = !ready;
  ui.draftBtn.disabled = !ready;
  ui.explainCloudBtn.disabled = !ready;
  ui.draftCloudBtn.disabled = !ready;
  ui.cloudGateBtn.disabled = !ready;
}

function resetPreview(): void {
  ui.masked.textContent = "";
  ui.counts.textContent = "";
  ui.preflight.textContent = "";
  ui.preflight.classList.remove("error", "ok");
  ui.preview.hidden = true;
  ui.llmNote.textContent = "";
}

function resetExplain(): void {
  ui.explainStep.textContent = "";
  ui.explainText.textContent = "";
  ui.explainText.classList.remove("provisional");
  ui.explainSource.textContent = "";
  ui.explainWarning.textContent = "";
  ui.explainWarning.hidden = true;
  ui.explainResult.hidden = true;
  ui.explainError.textContent = "";
  ui.explainError.hidden = true;
}

function resetDraft(): void {
  lastDraft = "";
  lastDraftInstruction = "";
  ui.draftStep.textContent = "";
  ui.draftText.textContent = "";
  ui.draftText.classList.remove("provisional");
  ui.draftSource.textContent = "";
  ui.draftWarning.textContent = "";
  ui.draftWarning.hidden = true;
  ui.draftResult.hidden = true;
  ui.draftCopyBtn.hidden = true;
  ui.draftCopyBtn.textContent = "Copy draft";
  ui.draftError.textContent = "";
  ui.draftError.hidden = true;
}

function resetAction(a: Action): void {
  if (a === "explain") resetExplain();
  else resetDraft();
}

function beginAction(a: Action): number {
  const token = ++actionToken;
  lastAction = a;
  setState(a === "explain" ? "explaining" : "drafting");
  return token;
}

function owns(token: number, myRun: number): boolean {
  return token === actionToken && myRun === runId;
}

function discardStale(a: Action): void {
  resetAction(a);
  out[a].step.textContent = "The text changed while this was running, so the result was discarded. Click Redact again.";
  setState("ready");
}

function showStreaming(a: Action): void {
  const o = out[a];
  o.text.textContent = "";
  o.text.classList.add("provisional");
  o.source.textContent = STREAMING_LABEL;
  o.result.hidden = false;
}

function endStreaming(a: Action): void {
  out[a].text.classList.remove("provisional");
}

function renderRedaction(result: RedactResult): void {
  renderMaskedChips(ui.masked, result.masked);
  renderCountChips(ui.counts, result.counts, NO_IDENTIFIERS);
  const check = preflightCheck(result.masked);
  ui.preflight.classList.toggle("error", !check.ok);
  ui.preflight.classList.toggle("ok", check.ok);
  ui.preflight.textContent = check.ok ? `Pre-flight OK: ${preflightLine(check)}` : `Pre-flight on the redacted text: ${preflightLine(check)}`;
  ui.preview.hidden = false;
}

// ---------------------------------------------------------------- redact
type LlmPassOutcome = { result: RedactResult | null; status: EntityPassStatus; cause: DeterministicOnlyCause | null };

async function runLlmPass(raw: string, docId: string, myRun: number): Promise<LlmPassOutcome> {
  const fallback = (status: EntityPassStatus, cause: DeterministicOnlyCause): LlmPassOutcome => {
    if (myRun === runId) ui.llmNote.textContent = deterministicOnlyPanelLine(cause);
    return { result: null, status, cause };
  };
  if (!isFirebaseInitialized()) return fallback("unavailable", "unavailable");
  const availability = await probeNanoWithTimeout();
  if (myRun !== runId) return { result: null, status: "pending", cause: null };
  if (availability === "unavailable") return fallback("unavailable", "unavailable");
  if (raw.length > LLM_EXTRACT_MAX_CHARS) {
    ui.llmNote.textContent = `${LLM_SKIPPED_TOO_LONG_NOTE}. Showing regex-only redaction.`;
    return { result: null, status: "skipped_too_long", cause: null };
  }
  try {
    ui.llmNote.textContent = availability === "available"
      ? "Running on-device entity pass (Gemini Nano)..."
      : "Preparing Gemini Nano (first run downloads the model; progress shown below)...";
    const started = await withTimeout(startDeviceModel(setProgress), NANO_START_TIMEOUT_MS);
    if (myRun !== runId) return { result: null, status: "pending", cause: null };
    if (started === TIMED_OUT) {
      // The download / init keeps going in the background; a later Redact click can use it.
      return fallback("failed", "timeout");
    }
    setProgress(100);
    void refreshNano();
    ui.llmNote.textContent = "Running on-device entity pass (Gemini Nano)...";
    const extracted = await withTimeout(extractEntitiesOnDevice(raw), NANO_EXTRACT_TIMEOUT_MS);
    if (myRun !== runId) return { result: null, status: "pending", cause: null };
    if (extracted === TIMED_OUT) return fallback("failed", "timeout");
    const { detections, warnings, ok } = extracted;
    const result = redactWithLlm(raw, detections, { docId });
    const extra = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
    ui.llmNote.textContent = `On-device entity pass added ${detections.length} verified span(s) before merging.${extra}`;
    if (!ok) {
      ui.llmNote.textContent += ` ${deterministicOnlyPanelLine("failed")}`;
      return { result, status: "failed", cause: "failed" };
    }
    return { result, status: "complete", cause: null };
  } catch (err) {
    if (myRun !== runId) return { result: null, status: "pending", cause: null };
    const res = fallback("failed", "failed");
    ui.llmNote.textContent = `On-device entity pass failed (${errLabel(err)}). ${ui.llmNote.textContent}`;
    return res;
  }
}

async function onRedact(): Promise<void> {
  if (BUSY.has(state)) return;
  const myRun = ++runId;
  ui.status.textContent = "";
  resetExplain();
  resetDraft();
  const raw = ui.input.value;
  currentEntityPass = "pending";
  currentPassCause = null;
  if (!raw.trim()) {
    resetPreview();
    currentRaw = null;
    currentMasked = null;
    ui.status.textContent = "Paste or load a sample first.";
    setState("idle");
    return;
  }
  setState("redacting");

  const base = redact(raw);
  currentMap = base.map;
  currentRaw = raw;
  currentMasked = base.masked;
  ui.llmNote.textContent = "";
  renderRedaction(base);
  ui.status.textContent = `Placeholder map kept in this page only (${base.map.entries.length} entries).`;
  if (myRun !== runId) return;

  const { result: withLlm, status: entityPass, cause } = await runLlmPass(raw, base.map.docId, myRun);
  if (myRun !== runId) return;
  if (withLlm) {
    currentMap = withLlm.map;
    currentMasked = withLlm.masked;
    renderRedaction(withLlm);
    ui.status.textContent = `Placeholder map kept in this page only (${withLlm.map.entries.length} entries).`;
  }
  currentEntityPass = entityPass;
  currentPassCause = cause;
  if (myRun !== runId) return;
  setState("ready");
}

// ---------------------------------------------------------------- router
async function route(a: Action, flags: { userRequestedCloud?: boolean; onDeviceFailed?: boolean }): Promise<RouteDecision> {
  const raw = currentRaw ?? "";
  const redacted = currentMasked ?? "";
  const nanoAvailable = await nanoIsAvailable();
  if (a === "explain") {
    return decideRoute({
      redactedChars: redacted.length,
      rawChars: raw.length,
      question: "",
      overheadChars: buildExplainPrompt("").length,
      nanoAvailable,
      ...flags,
    });
  }
  const instruction = normalizeDraftInstruction(ui.draftInstruction.value);
  return decideRoute({
    redactedChars: redacted.length,
    question: instruction,
    overheadChars: buildDraftPrompt("", instruction).length - instruction.length,
    nanoAvailable,
    ...flags,
  });
}

// ---------------------------------------------------------------- consent gate
async function prepareInstruction(
  instruction: string,
  map: PlaceholderMap,
): Promise<{ masked: string; map: PlaceholderMap; status: EntityPassStatus; cause: DeterministicOnlyCause | null }> {
  let detections: Detection[] = [];
  let status: EntityPassStatus = "unavailable";
  let cause: DeterministicOnlyCause | null = "unavailable";
  if (isFirebaseInitialized()) {
    const availability = await probeNanoWithTimeout();
    if (availability !== "unavailable") {
      try {
        const started = await withTimeout(startDeviceModel(setProgress), NANO_START_TIMEOUT_MS);
        if (started === TIMED_OUT) {
          status = "failed";
          cause = "timeout";
        } else {
          const r = await withTimeout(extractEntitiesOnDevice(instruction), NANO_EXTRACT_TIMEOUT_MS);
          if (r === TIMED_OUT) {
            status = "failed";
            cause = "timeout";
          } else {
            detections = r.detections;
            status = r.ok ? "complete" : "failed";
            cause = r.ok ? null : "failed";
          }
        }
      } catch {
        status = "failed";
        cause = "failed";
      }
    }
  }
  // Deterministic detectors always run on the instruction (redactWithMap), with or without Nano.
  const red = redactWithMap(instruction, detections, map, { reservedTexts: [currentRaw ?? ""] });
  return { masked: red.masked, map: red.map, status, cause };
}

async function openConsent(
  a: Action,
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
  lastAction = a;

  let map = docMap;
  let instruction = "";
  let maskedInstruction = "";
  let instructionPass: EntityPassStatus | "not_needed" = "not_needed";
  let instructionCause: DeterministicOnlyCause | null = null;
  if (a === "draft") {
    instruction = normalizeDraftInstruction(ui.draftInstruction.value);
    if (instruction) {
      out.draft.step.textContent = "Checking your instruction for names and addresses in this browser...";
      const prepared = await prepareInstruction(instruction, docMap);
      if (!owns(token, myRun)) return;
      map = prepared.map;
      maskedInstruction = prepared.masked;
      instructionPass = prepared.status;
      instructionCause = prepared.status === "complete" ? null : prepared.cause;
    }
  }

  const payload = buildCloudPayload(redacted, a === "explain" ? { kind: "explain" } : { kind: "draft", instruction: maskedInstruction });
  pending = { action: a, payload, map, runId: myRun, raw, instruction, entityPass: currentEntityPass, instructionPass, instructionCause };

  ui.consentReasons.replaceChildren(...reasons.map((r) => {
    const li = document.createElement("li");
    li.textContent = reasonLine(r, ctx);
    return li;
  }));
  ui.consentChars.textContent = payload.text.length.toLocaleString("en-US");
  ui.consentPreview.textContent = payload.text;
  ui.consentPreview.scrollTop = 0;

  // Pre-flight + map-leak always run on the exact previewed string. The entity-pass part of
  // the gate uses the demo's deterministic-only policy (see DETERMINISTIC_ONLY_OK).
  const gate = checkCloudSend(payload.text, map, currentEntityPass);
  const docPassOk = entityPassAllowsSend(gate.entityPass);
  const instructionPassOk = instructionPass === "not_needed" || entityPassAllowsSend(instructionPass);
  const deterministicOk = gate.preflight.ok && gate.leaks.length === 0;
  ui.consentCounts.textContent = consentCountsLine(summarizeMasked(map), gate.preflight);
  ui.consentCounts.classList.toggle("error", !(deterministicOk && docPassOk && instructionPassOk));

  const blocked: string[] = [];
  if (!docPassOk) blocked.push(entityPassBlockedLine(gate.entityPass));
  if (!instructionPassOk) blocked.push(instructionPassBlockedLine(instructionPass));
  if (!gate.preflight.ok) blocked.push(preflightLine(gate.preflight));
  if (gate.leaks.length > 0) blocked.push(leakLine(gate.leaks));
  if (!isFirebaseInitialized()) blocked.push("Firebase AI Logic / App Check is not initialized, so the cloud cannot be used. Nothing will be sent.");
  ui.consentBlocked.textContent = blocked.join("\n");
  ui.consentBlocked.hidden = blocked.length === 0;
  ui.consentSend.disabled = blocked.length > 0;

  // Honest, non-blocking note: what the user is approving when Nano did not run.
  const docCause = gate.entityPass !== "complete" && docPassOk ? (currentPassCause ?? gate.entityPass) : null;
  const instrCause = instructionPass !== "not_needed" && instructionPass !== "complete" && instructionPassOk
    ? (instructionCause ?? instructionPass)
    : null;
  ui.consentNote.textContent = docCause || instrCause ? deterministicOnlyConsentLine(docCause, instrCause) : "";
  ui.consentNote.hidden = !(docCause || instrCause);

  setState("awaiting_consent");
  setPendingConsent(true);
  out[a].step.textContent = "Waiting for your decision in the consent dialog...";
  if (!ui.dialog.open) ui.dialog.showModal();
  ui.consentCancel.focus();
}

function onConsentDismissed(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  setPendingConsent(false);
  out[p.action].step.textContent = cancelLine(p.action);
  setState("ready");
}

async function onConsentSend(): Promise<void> {
  const p = pending;
  if (!p || state !== "awaiting_consent" || ui.consentSend.disabled) return;
  if (p.runId !== runId || !isFirebaseInitialized()) {
    ui.dialog.close("cancel");
    return;
  }
  // If the text was edited since the dialog opened, currentEntityPass went back to "pending" and blocks.
  const entityPass: EntityPassStatus = currentEntityPass === "pending" ? "pending" : p.entityPass;
  const o = out[p.action];
  let started = false;
  try {
    // Guarded send: every check runs on the exact previewed string BEFORE the cloud is reached.
    assertEntityPassAllowsSend(entityPass);
    if (p.instructionPass !== "not_needed") assertEntityPassAllowsSend(p.instructionPass, "instruction");
    assertPreflight(p.payload.text);
    assertNoMapLeaks(p.payload.text, p.map);

    started = true;
    pending = null;
    sessionSentChars += p.payload.text.length;
    ui.dialog.close("send");
    resetAction(p.action);
    setState("cloud_running");
    o.step.textContent = "Sending the redacted text to Firebase AI Logic (ONLY_IN_CLOUD, streaming). Placeholders are filled in locally when it finishes...";
    showStreaming(p.action);

    const { text, inferenceSource, complete, finishReason } = await generateInCloudStream(p.payload.text, (chunk) => {
      o.text.textContent += chunk;
    });
    endStreaming(p.action);

    if (!text.trim()) {
      setPrivacy(cloudEmptyLine(p.payload.text.length));
      setPendingConsent(false);
      if (p.runId !== runId) return;
      resetAction(p.action);
      o.step.textContent = "Failed.";
      o.error.textContent = "The cloud returned an empty answer. Your redacted request was sent, but nothing came back. The placeholder map stayed in this browser.";
      o.error.hidden = false;
      setState("ready");
      return;
    }
    setPrivacy(cloudStatusLine(p.payload.text.length));
    if (p.runId !== runId) { setPendingConsent(false); return; }
    if (ui.input.value !== p.raw) { setPendingConsent(false); discardStale(p.action); return; }

    const result = unmask(text, p.map);
    o.text.textContent = result.text;
    if (result.suspects > 0) {
      o.warning.textContent = `Hid ${result.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
      o.warning.hidden = false;
    }
    o.source.textContent = inferenceSource;
    setBadge(inferenceSource);
    if (!complete) {
      o.step.textContent = incompleteStepLine(finishReason);
      setState("done");
      return;
    }
    if (p.action === "draft") {
      lastDraft = result.text;
      lastDraftInstruction = p.instruction;
    }
    o.step.textContent = p.action === "draft" ? "Done. Review the draft before sending it." : "Done.";
    if (p.action === "draft" && normalizeDraftInstruction(ui.draftInstruction.value) !== p.instruction) {
      lastDraft = "";
      o.step.textContent = INSTRUCTION_CHANGED;
    }
    if (p.action === "draft") ui.draftCopyBtn.hidden = lastDraft.length === 0;
    setState("done");
  } catch (err) {
    endStreaming(p.action);
    if (!started) {
      ui.consentSend.disabled = true;
      ui.consentBlocked.textContent =
        err instanceof EntityPassIncompleteError
          ? err.scope === "instruction" ? instructionPassBlockedLine(err.status) : entityPassBlockedLine(err.status)
          : err instanceof PreflightError
            ? preflightLine({ ok: false, hits: err.hits })
            : err instanceof MapLeakError
              ? leakLine(err.hits)
              : "Pre-flight failed. Nothing was sent.";
      ui.consentBlocked.hidden = false;
      return;
    }
    if (!(err instanceof PreflightError)) {
      setPrivacy(`Tried to send ${p.payload.text.length.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud); the request failed. The placeholder map stayed here.`);
    }
    setPendingConsent(false);
    if (p.runId !== runId) return;
    o.text.textContent = "";
    o.result.hidden = true;
    if (p.action === "draft") { lastDraft = ""; ui.draftCopyBtn.hidden = true; }
    o.step.textContent = "Failed.";
    o.error.textContent = `Cloud request failed (${errLabel(err)}). The placeholder map stayed in this browser.`;
    o.error.hidden = false;
    setState("ready");
  }
}

async function offerCloud(a: Action, flags: { userRequestedCloud?: boolean; onDeviceFailed?: boolean }): Promise<void> {
  const myRun = runId;
  const token = beginAction(a);
  try {
    const decision = await route(a, flags);
    if (!owns(token, myRun) || pending) return;
    if (decision.route === "offer_cloud") {
      await openConsent(a, decision.reasons, decision, token, myRun);
      return;
    }
    setState("ready");
  } catch (err) {
    if (!owns(token, myRun)) return;
    out[a].step.textContent = `Could not open the cloud review (${errLabel(err)}). Nothing was sent.`;
    setState("ready");
  }
}

async function onDeeper(a: Action): Promise<void> {
  if (!docReady()) return;
  resetAction(a);
  out[a].step.textContent = "Preparing the redacted copy for review...";
  await offerCloud(a, { userRequestedCloud: true });
}

async function onDeviceFailure(a: Action, myRun: number, message: string): Promise<void> {
  if (myRun !== runId) return;
  const o = out[a];
  if (a === "draft") { lastDraft = ""; ui.draftCopyBtn.hidden = true; }
  o.text.textContent = "";
  o.result.hidden = true;
  o.text.classList.remove("provisional");
  o.step.textContent = "Failed.";
  o.error.textContent = `${message} Nothing was sent to the cloud; there is no automatic cloud fallback.`;
  o.error.hidden = false;
  setState("error");
  await offerCloud(a, { onDeviceFailed: true });
}

// ---------------------------------------------------------------- explain / draft
async function onExplain(): Promise<void> {
  if (!docReady()) return;
  const raw = currentRaw;
  const map = currentMap;
  if (raw === null || map === null) return;
  const myRun = runId;
  lastAction = "explain";
  resetExplain();
  if (!isFirebaseInitialized()) {
    ui.explainStep.textContent = "Explain unavailable: Firebase AI Logic is not initialized (see the banner). Nothing was sent anywhere.";
    return;
  }
  const token = beginAction("explain");
  ui.explainStep.textContent = "Checking whether this fits on-device...";
  const decision = await route("explain", {});
  if (!owns(token, myRun)) return;
  if (decision.route === "offer_cloud") {
    await openConsent("explain", decision.reasons, decision, token, myRun);
    return;
  }
  try {
    ui.explainStep.textContent = "Preparing Gemini Nano...";
    await startDeviceModel(setProgress);
    setProgress(100);
    ui.explainStep.textContent = "Explaining on-device (ONLY_ON_DEVICE, streaming)...";
    showStreaming("explain");
    const { text, inferenceSource } = await generateOnDeviceStream(buildExplainPrompt(raw), (chunk) => {
      ui.explainText.textContent += chunk;
    });
    if (!owns(token, myRun)) return;
    endStreaming("explain");
    if (!text.trim()) { await onDeviceFailure("explain", myRun, "On-device explain returned an empty answer."); return; }
    if (ui.input.value !== raw) { discardStale("explain"); return; }
    const o = unmask(text, map);
    ui.explainText.textContent = o.text;
    if (o.suspects > 0) {
      ui.explainWarning.textContent = `Hid ${o.suspects} identifier(s) in the answer that did not come from your document's placeholder map.`;
      ui.explainWarning.hidden = false;
    }
    ui.explainSource.textContent = inferenceSource;
    setBadge(inferenceSource);
    if (inferenceSource === InferenceSource.ON_DEVICE) setPrivacy(onDevicePrivacyLine(sessionSentChars));
    ui.explainStep.textContent = "Done.";
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
  const instruction = ui.draftInstruction.value;
  const rawAtStart = currentRaw;
  resetDraft();
  if (!isFirebaseInitialized()) {
    ui.draftStep.textContent = "Draft unavailable: Firebase AI Logic is not initialized (see the banner). Nothing was sent anywhere.";
    return;
  }
  const token = beginAction("draft");
  ui.draftStep.textContent = "Checking whether this fits on-device...";
  const decision = await route("draft", {});
  if (!owns(token, myRun)) return;
  if (decision.route === "offer_cloud") {
    await openConsent("draft", decision.reasons, decision, token, myRun);
    return;
  }
  try {
    ui.draftStep.textContent = "Preparing Gemini Nano...";
    await startDeviceModel(setProgress);
    setProgress(100);
    ui.draftStep.textContent = "Drafting on-device from the redacted text (ONLY_ON_DEVICE, streaming). Placeholders are filled in locally when it finishes...";
    showStreaming("draft");
    const outcome = await draftReplyOnDevice(redacted, instruction, (chunk) => {
      ui.draftText.textContent += chunk;
    });
    if (!owns(token, myRun)) return;
    endStreaming("draft");
    if (outcome.kind === "too_long") {
      ui.draftText.textContent = "";
      ui.draftResult.hidden = true;
      ui.draftStep.textContent = outcome.message;
      await offerCloud("draft", {});
      return;
    }
    if (!outcome.text.trim()) { await onDeviceFailure("draft", myRun, "On-device draft returned an empty answer."); return; }
    if (ui.input.value !== rawAtStart) { discardStale("draft"); return; }
    const o = unmask(outcome.text, map);
    ui.draftText.textContent = o.text;
    lastDraft = o.text;
    lastDraftInstruction = normalizeDraftInstruction(instruction);
    if (o.suspects > 0) {
      ui.draftWarning.textContent = `Hid ${o.suspects} identifier(s) in the draft that did not come from your document's placeholder map.`;
      ui.draftWarning.hidden = false;
    }
    ui.draftSource.textContent = outcome.inferenceSource;
    setBadge(outcome.inferenceSource);
    if (outcome.inferenceSource === InferenceSource.ON_DEVICE) setPrivacy(onDevicePrivacyLine(sessionSentChars));
    ui.draftStep.textContent = "Done. Review the draft before sending it.";
    if (normalizeDraftInstruction(ui.draftInstruction.value) !== lastDraftInstruction) {
      lastDraft = "";
      ui.draftStep.textContent = INSTRUCTION_CHANGED;
    }
    ui.draftCopyBtn.hidden = lastDraft.length === 0;
    setState("done");
  } catch (err) {
    await onDeviceFailure("draft", myRun, `On-device draft failed (${errLabel(err)}).`);
  }
}

function onCopyDraft(): void {
  if (!lastDraft) return;
  void navigator.clipboard.writeText(lastDraft).then(
    () => { ui.draftCopyBtn.textContent = "Copied"; },
    () => { ui.draftCopyBtn.textContent = "Copy failed"; },
  );
}

function resetDocument(): void {
  runId++;
  ui.input.value = "";
  ui.draftInstruction.value = "";
  ui.sampleSelect.value = "";
  resetPreview();
  resetExplain();
  resetDraft();
  currentMap = null;
  currentRaw = null;
  currentMasked = null;
  currentEntityPass = "pending";
  currentPassCause = null;
  setState("idle");
  ui.status.textContent = "Cleared. Nothing from the previous document is kept.";
}

// ---------------------------------------------------------------- events
ui.sampleSelect.addEventListener("change", () => {
  if (BUSY.has(state)) return;
  const s = SAMPLES.find((x) => x.id === ui.sampleSelect.value);
  if (!s) return;
  resetDocument();
  ui.input.value = s.text;
  ui.sampleSelect.value = s.id;
  ui.status.textContent = `Loaded "${s.label}" (${s.text.length.toLocaleString()} characters). Click Redact.`;
});
ui.input.addEventListener("input", () => {
  const hadDoc = (state === "ready" || state === "done") && currentRaw !== null;
  if (ui.input.value !== currentRaw && currentEntityPass !== "pending") currentEntityPass = "pending";
  setState(state);
  if (hadDoc && ui.input.value !== currentRaw) {
    resetExplain();
    resetDraft();
    ui.explainStep.textContent = "Text changed. Click Redact again before explaining.";
    ui.draftStep.textContent = "Text changed. Click Redact again before drafting.";
  } else if (hadDoc) {
    ui.explainStep.textContent = "";
    ui.draftStep.textContent = "";
  }
});
ui.draftInstruction.addEventListener("input", () => {
  if (BUSY.has(state) || !lastDraft) return;
  if (normalizeDraftInstruction(ui.draftInstruction.value) === lastDraftInstruction) return;
  lastDraft = "";
  ui.draftCopyBtn.hidden = true;
  ui.draftStep.textContent = INSTRUCTION_CHANGED;
});
ui.redactBtn.addEventListener("click", () => { void onRedact(); });
ui.explainBtn.addEventListener("click", () => { void onExplain(); });
ui.draftBtn.addEventListener("click", () => { void onDraft(); });
ui.explainCloudBtn.addEventListener("click", () => { void onDeeper("explain"); });
ui.draftCloudBtn.addEventListener("click", () => { void onDeeper("draft"); });
ui.cloudGateBtn.addEventListener("click", () => { void onDeeper(lastAction); });
ui.consentCancel.addEventListener("click", () => { ui.dialog.close("cancel"); });
ui.consentSend.addEventListener("click", () => { void onConsentSend(); });
ui.dialog.addEventListener("close", onConsentDismissed);
ui.draftCopyBtn.addEventListener("click", onCopyDraft);
ui.newDocBtn.addEventListener("click", () => { if (!BUSY.has(state)) resetDocument(); });

// Static gate copy.
byId("consent-title").textContent = CONSENT_TITLE;
byId("consent-lede").textContent = CONSENT_LEDE;
byId("consent-destination").textContent = CONSENT_DESTINATION;
ui.consentSend.textContent = SEND_LABEL;

// Populate the sample picker.
for (const s of SAMPLES) {
  const opt = document.createElement("option");
  opt.value = s.id;
  opt.textContent = s.label;
  ui.sampleSelect.appendChild(opt);
}

setState("idle");
boot();
