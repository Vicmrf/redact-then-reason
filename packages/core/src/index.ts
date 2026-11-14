export const CORE_VERSION = "0.1.0";

export {
  initFirebase,
  isFirebaseInitialized,
  FirebaseNotConfiguredError,
  type FirebaseHandles,
  type InitFirebaseOptions,
} from "./firebase/init";
export {
  CLOUD_MODEL_NAME,
  ON_DEVICE_PARAMS,
  piiSchema,
  getOnDeviceModel,
  getCloudModel,
  getPiiModel,
} from "./firebase/models";
export {
  startDeviceModel,
  generateOnDevice,
  generateOnDeviceStream,
  generateInCloud,
  generateInCloudStream,
  type GenerateResult,
} from "./firebase/generate";
export { probeNano, TEXT_OPTS } from "./firebase/probe";

// Redaction engine (Day 2).
export type {
  EntityType,
  PlaceholderEntry,
  PlaceholderMap,
  Detection,
  DetectionSource,
  TypeCount,
} from "./types";
export { luhnOk } from "./redaction/luhn";
export {
  detectEmails,
  detectCreditCards,
  detectSSNs,
  detectPhones,
  detectDeterministic,
  detectHighRisk,
} from "./redaction/regex";
export { mergeDetections, DETERMINISTIC_TYPES } from "./redaction/merge";
export { mask, type MaskOptions, type MaskResult } from "./redaction/mask";
export { unmask, SUSPECT_TOKEN, type UnmaskResult } from "./redaction/unmask";
export { redact, redactWithLlm, countByType, type RedactResult } from "./redaction/redact";
export {
  expandToAllOccurrences,
  findOccurrences,
  nonSpaceLength,
  MIN_EXPAND_CHARS,
} from "./redaction/occurrences";
// On-device LLM extraction + explain (Day 3).
export {
  extractEntitiesOnDevice,
  verifyLlmSpans,
  parseLlmEntities,
  buildPiiExtractPrompt,
  LLM_ENTITY_TYPES,
  LLM_EXTRACT_MAX_CHARS,
  LLM_SKIPPED_TOO_LONG_NOTE,
  type LlmEntity,
  type LlmEntityType,
  type LlmExtractResult,
} from "./redaction/llmExtract";
export {
  buildExplainPrompt,
  estimateTokens,
  estimateTokensFromChars,
  fitsOnDeviceBudget,
  ON_DEVICE_INPUT_BUDGET,
  PLACEHOLDER_RULE,
} from "./prompts/explain";
// Draft reply (Day 4).
export {
  buildDraftPrompt,
  normalizeDraftInstruction,
  draftFitsOnDevice,
  DRAFT_INSTRUCTION_MAX_CHARS,
  TOO_LONG_FOR_DRAFT,
} from "./prompts/draft";
export { draftReplyOnDevice, type DraftOutcome } from "./firebase/draft";
export {
  preflightCheck,
  assertPreflight,
  PreflightError,
  PREFLIGHT_BLOCKING_TYPES,
  type PreflightResult,
} from "./consent/preflight";
// Router + consent gate primitives (generic; UI copy lives in the UI packages).
export {
  buildCloudPayload,
  summarizeMasked,
  ENTITY_TYPE_ORDER,
  type CloudAction,
  type CloudPayload,
} from "./consent/payload";
export {
  findMapLeaks,
  assertNoMapLeaks,
  checkCloudSend,
  MapLeakError,
  MIN_LEAK_CHARS,
  type CloudSendCheck,
  type CloudSendBlockReason,
} from "./consent/leaks";
export {
  ENTITY_PASS_STATUSES,
  toEntityPassStatus,
  isEntityPassComplete,
  assertEntityPassComplete,
  EntityPassIncompleteError,
  type EntityPassStatus,
} from "./consent/entityPass";
export {
  decideRoute,
  classifyHardQuestion,
  estimateOnDeviceTokens,
  HARD_QUESTION_PATTERNS,
  type RouteDecision,
  type RouteInput,
  type RouteReason,
  type HardQuestionFamily,
} from "./router/route";

// Re-exported so UI packages compare against the SDK constants, not guessed strings.
export { InferenceSource } from "firebase/ai";
