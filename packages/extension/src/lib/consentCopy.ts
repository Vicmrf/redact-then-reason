// UI copy for the router + consent gate (ARCHITECTURE 3.3, 3.6, 4.2, 5). Pure functions:
// they take types, counts and reason codes only, never document text or matched values.
import type {
  EntityPassStatus,
  EntityType,
  HardQuestionFamily,
  PreflightResult,
  RouteReason,
  TypeCount,
} from "@rtr/core";
import { ON_DEVICE_INPUT_BUDGET, PREFLIGHT_BLOCKING_TYPES } from "@rtr/core";

export const CONSENT_TITLE = "Send a redacted copy to the cloud?";
export const CONSENT_LEDE =
  "The original stays on this device; only the masked text below will be sent to Firebase AI Logic (Gemini cloud) to answer a harder or longer request.";
export const CONSENT_DESTINATION =
  "Firebase AI Logic / Gemini Developer API. The placeholder map is not included.";
export const SEND_LABEL = "Send redacted text to cloud";
export const DEEPER_LABEL = "Use cloud for a deeper answer";
export const NOTHING_LEFT = "Nothing has left this device.";

const NOUNS: Record<EntityType, [string, string]> = {
  PERSON: ["name", "names"],
  EMAIL: ["email", "emails"],
  PHONE: ["phone number", "phone numbers"],
  SSN: ["SSN", "SSNs"],
  CREDIT_CARD: ["card number", "card numbers"],
  ADDRESS: ["address", "addresses"],
  ORG: ["organization", "organizations"],
  DOB: ["date of birth", "dates of birth"],
  DATE: ["date", "dates"],
  ACCOUNT: ["account number", "account numbers"],
  MRN: ["medical record number", "medical record numbers"],
  IP: ["IP address", "IP addresses"],
  OTHER: ["other identifier", "other identifiers"],
};

export function countNoun(type: EntityType, count: number): string {
  const [one, many] = NOUNS[type];
  return `${count} ${count === 1 ? one : many}`;
}

export function joinCounts(counts: readonly TypeCount[]): string {
  return counts.map((c) => countNoun(c.type, c.count)).join(", ");
}

/** "12 names, 3 emails, 1 SSN masked." */
export function maskedSummaryLine(counts: readonly TypeCount[]): string {
  return counts.length === 0 ? "Nothing was masked." : `${joinCounts(counts)} masked.`;
}

/** Pre-flight line for the consent modal and the redaction preview. Counts by type only. */
export function preflightLine(result: PreflightResult): string {
  if (result.ok) return "0 unmasked emails/SSNs/cards/phones detected in the outgoing text.";
  const blocking = result.hits.filter((h) => PREFLIGHT_BLOCKING_TYPES.has(h.type));
  return `Blocked: the outgoing text still contains ${joinCounts(blocking)}. Send is disabled; nothing will be sent.`;
}

/**
 * Leak-check line: map originals that still appear in the outgoing text. Counts by type only;
 * never the values. Empty string when there are no leaks.
 */
export function leakLine(leaks: readonly TypeCount[]): string {
  if (leaks.length === 0) return "";
  return `Blocked: the outgoing text still contains ${joinCounts(leaks)} from your document that should have been masked. This check ignores capitals, spacing and line breaks, so a differently written copy (for example "JANE DOE" for "Jane Doe") also blocks, even though masking only replaced the exact spelling. Send is disabled; nothing will be sent.`;
}

/** Shown (with a reason line) whenever the on-device entity pass did not complete for the document. */
export const ENTITY_PASS_BLOCKED =
  "Names and addresses couldn't be checked on this device for this document, so it can't be sent to the cloud yet.";

/** Short reason-specific second line for ENTITY_PASS_BLOCKED. Unknown values read as "not finished". */
export function entityPassReasonLine(status: EntityPassStatus | undefined): string {
  switch (status) {
    case "skipped_too_long":
      return "The document is too long for the on-device check.";
    case "unavailable":
      return "The on-device model is unavailable.";
    case "failed":
      return "The on-device check failed.";
    case "complete":
      return "";
    default:
      return "The on-device check hasn't finished for the current text. Click Redact again.";
  }
}

/** Two-line block message for the consent dialog; empty string when the pass is complete. */
export function entityPassBlockedLine(status: EntityPassStatus | undefined): string {
  if (status === "complete") return "";
  return `${ENTITY_PASS_BLOCKED}\n${entityPassReasonLine(status)}`;
}

/** Instruction variant of ENTITY_PASS_BLOCKED (draft instruction sent along with the document). */
export const INSTRUCTION_PASS_BLOCKED =
  "Names and addresses in your instruction couldn't be checked on this device, so it can't be sent to the cloud yet.";

/** Two-line block message for the draft instruction's entity pass; empty when complete / not needed. */
export function instructionPassBlockedLine(status: EntityPassStatus | "not_needed" | undefined): string {
  if (status === "complete" || status === "not_needed") return "";
  const reason =
    status === "pending" || status === undefined
      ? "The on-device check hasn't finished for the current instruction. Close this and try again."
      : entityPassReasonLine(status);
  return `${INSTRUCTION_PASS_BLOCKED}\n${reason}`;
}

/** Shown in the result while text streams in: it has not been validated / unmasked yet. */
export const STREAMING_LABEL = "Streaming — not final";

/**
 * Footer privacy line after an ON-DEVICE result. Never claims "nothing left" when redacted text
 * from this document (or, earlier, from another document in this session) was sent.
 */
export function onDevicePrivacyLine(docSentChars: number, sessionSentChars: number): string {
  if (docSentChars > 0) {
    return `This answer was generated on-device. Earlier, ${docSentChars.toLocaleString("en-US")} characters of redacted text from this document were sent to Firebase AI Logic (Gemini cloud).`;
  }
  if (sessionSentChars > 0) {
    return "This answer was generated on-device and nothing from this document has left this device. Earlier in this session, redacted text from another document was sent to Firebase AI Logic (Gemini cloud).";
  }
  return NOTHING_LEFT;
}

/** Footer after the on-device hello check: still honest about earlier cloud sends this session. */
export function helloPrivacyLine(sessionSentChars: number): string {
  return sessionSentChars > 0
    ? `The hello check ran on-device. Earlier in this session, ${sessionSentChars.toLocaleString("en-US")} characters of redacted text were sent to Firebase AI Logic (Gemini cloud).`
    : NOTHING_LEFT;
}

/** The request went out but no answer text came back (Codex 13). */
export function cloudEmptyLine(chars: number): string {
  return `Sent ${chars.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud), but no answer came back. The placeholder map stayed here.`;
}

/** Step line for a partial answer (finishReason other than STOP). */
export function incompleteStepLine(finishReason: string | undefined): string {
  return `Incomplete (${finishReason ?? "unknown reason"}): the answer below may be cut off or partly withheld. It is not a finished answer.`;
}

/** Counts line exactly as ARCHITECTURE 5 shows it: masked summary + pre-flight result. */
export function consentCountsLine(masked: readonly TypeCount[], result: PreflightResult): string {
  return `${maskedSummaryLine(masked)} ${preflightLine(result)}`;
}

const HARD_FAMILY_COPY: Record<HardQuestionFamily, string> = {
  comparison: "a comparison",
  multi_hop: "multi-step reasoning",
  enumerate_all: "listing every item",
  inconsistencies: "finding inconsistencies",
  compute: "a calculation",
};

export function reasonLine(
  reason: RouteReason,
  ctx: { estimatedTokens?: number; hardQuestion?: readonly HardQuestionFamily[] } = {},
): string {
  switch (reason) {
    case "nano_unavailable":
      return "Gemini Nano is not available on this device, so this cannot run on-device.";
    case "over_budget": {
      const est = ctx.estimatedTokens ? `about ${ctx.estimatedTokens.toLocaleString("en-US")} tokens; ` : "";
      return `The document and request are too long for the on-device model (${est}the on-device budget is ${ON_DEVICE_INPUT_BUDGET.toLocaleString("en-US")}).`;
    }
    case "user_requested_cloud":
      return "You asked for a deeper answer from the cloud.";
    case "hard_question": {
      const fams = (ctx.hardQuestion ?? []).map((f) => HARD_FAMILY_COPY[f]);
      return fams.length > 0
        ? `Your request looks hard for the on-device model (${fams.join(", ")}).`
        : "Your request looks hard for the on-device model.";
    }
    case "on_device_failed":
      return "The on-device model failed or returned an empty answer.";
  }
}

/** ARCHITECTURE 3.3 / 4.2 status line after a consented cloud call. */
export function cloudStatusLine(chars: number): string {
  return `Sent ${chars.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud). The placeholder map stayed here.`;
}

/** ARCHITECTURE 4.2 last line: consent refused, stay on-device. */
export function cancelLine(action: "explain" | "draft"): string {
  const tip =
    action === "explain"
      ? "To stay on-device, try a shorter selection of the document (explain it in parts)."
      : "To stay on-device, try a shorter instruction, or a shorter selection of the document.";
  return `Kept on this device. Nothing was sent. ${tip}`;
}
