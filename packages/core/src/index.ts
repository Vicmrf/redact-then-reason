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
  fitsOnDeviceBudget,
  ON_DEVICE_INPUT_BUDGET,
  PLACEHOLDER_RULE,
} from "./prompts/explain";
export {
  preflightCheck,
  assertPreflight,
  PreflightError,
  PREFLIGHT_BLOCKING_TYPES,
  type PreflightResult,
} from "./consent/preflight";

// Re-exported so UI packages compare against the SDK constants, not guessed strings.
export { InferenceSource } from "firebase/ai";
