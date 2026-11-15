// UI copy for the hosted demo's router + consent gate. Pure functions over types, counts and
// reason codes only — never document text or matched values. Mirrors the extension's
// lib/consentCopy.ts so the demo reads the same as the side panel.
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
  "The original stays in this browser; only the masked text below will be sent to Firebase AI Logic (Gemini cloud) to answer a harder or longer request.";
export const CONSENT_DESTINATION =
  "Firebase AI Logic / Gemini Developer API. The placeholder map is not included.";
export const SEND_LABEL = "Send redacted text to cloud";
export const STREAMING_LABEL = "Streaming — not final";
export const NOTHING_LEFT = "Nothing has left this browser.";

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

export function maskedSummaryLine(counts: readonly TypeCount[]): string {
  return counts.length === 0 ? "Nothing was masked." : `${joinCounts(counts)} masked.`;
}

export function preflightLine(result: PreflightResult): string {
  if (result.ok) return "0 unmasked emails/SSNs/cards/phones detected in the outgoing text.";
  const blocking = result.hits.filter((h) => PREFLIGHT_BLOCKING_TYPES.has(h.type));
  return `Blocked: the outgoing text still contains ${joinCounts(blocking)}. Send is disabled; nothing will be sent.`;
}

export function leakLine(leaks: readonly TypeCount[]): string {
  if (leaks.length === 0) return "";
  return `Blocked: the outgoing text still contains ${joinCounts(leaks)} from your document that should have been masked. This check ignores capitals, spacing and line breaks. Send is disabled; nothing will be sent.`;
}

export const ENTITY_PASS_BLOCKED =
  "Names and addresses couldn't be checked in this browser for this document, so it can't be sent to the cloud yet.";

export function entityPassReasonLine(status: EntityPassStatus | undefined): string {
  switch (status) {
    case "skipped_too_long":
      return "The document is too long for the on-device check.";
    case "unavailable":
      return "The on-device model is unavailable in this browser.";
    case "failed":
      return "The on-device check failed.";
    case "complete":
      return "";
    default:
      return "The on-device check hasn't finished for the current text. Click Redact again.";
  }
}

export function entityPassBlockedLine(status: EntityPassStatus | undefined): string {
  if (status === "complete") return "";
  return `${ENTITY_PASS_BLOCKED}\n${entityPassReasonLine(status)}`;
}

/**
 * Why the on-device name/address pass did not run, for the hosted demo's honest
 * deterministic-only note. "timeout" is a demo-only detail on top of the "failed" status.
 */
export type DeterministicOnlyCause = EntityPassStatus | "timeout";

function deterministicCauseLine(cause: DeterministicOnlyCause): string {
  switch (cause) {
    case "unavailable":
      return "Gemini Nano is not available in this browser";
    case "timeout":
      return "the on-device check did not finish in time";
    case "failed":
      return "the on-device check failed";
    default:
      return "the on-device check did not run";
  }
}

/** Shown in the redaction panel when only the deterministic detectors ran. */
export function deterministicOnlyPanelLine(cause: DeterministicOnlyCause): string {
  return `Only deterministic redaction was applied: ${deterministicCauseLine(cause)}, so names, organizations and street addresses were not machine-detected on this device. Emails, phone numbers, SSNs and card numbers (Luhn-checked) are masked above. Nothing was sent to the cloud. You can still review this exact redacted copy in the consent dialog before anything is sent.`;
}

/**
 * Shown in the consent dialog (non-blocking) when Send is allowed with deterministic-only
 * redaction, so the user knows exactly what they are approving.
 */
export function deterministicOnlyConsentLine(
  doc: DeterministicOnlyCause | null,
  instruction: DeterministicOnlyCause | null,
): string {
  const parts: string[] = [];
  if (doc) parts.push(`the document (${deterministicCauseLine(doc)})`);
  if (instruction) parts.push(`your instruction (${deterministicCauseLine(instruction)})`);
  return `Heads up: only deterministic redaction was applied to ${parts.join(" and ")}. Emails, phone numbers, SSNs and card numbers were masked and are re-checked right before sending, but names, organizations and street addresses were NOT machine-detected on this device. Anything in the text above that is not a [PLACEHOLDER] will be sent as written. Read it before you click Send.`;
}

export const INSTRUCTION_PASS_BLOCKED =
  "Names and addresses in your instruction couldn't be checked in this browser, so it can't be sent to the cloud yet.";

export function instructionPassBlockedLine(status: EntityPassStatus | "not_needed" | undefined): string {
  if (status === "complete" || status === "not_needed") return "";
  const reason =
    status === "pending" || status === undefined
      ? "The on-device check hasn't finished for the current instruction. Close this and try again."
      : entityPassReasonLine(status);
  return `${INSTRUCTION_PASS_BLOCKED}\n${reason}`;
}

export function onDevicePrivacyLine(sessionSentChars: number): string {
  if (sessionSentChars > 0) {
    return `This answer was generated on-device. Earlier in this session, ${sessionSentChars.toLocaleString("en-US")} characters of redacted text were sent to Firebase AI Logic (Gemini cloud).`;
  }
  return NOTHING_LEFT;
}

export function cloudEmptyLine(chars: number): string {
  return `Sent ${chars.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud), but no answer came back. The placeholder map stayed here.`;
}

export function incompleteStepLine(finishReason: string | undefined): string {
  return `Incomplete (${finishReason ?? "unknown reason"}): the answer below may be cut off or partly withheld. It is not a finished answer.`;
}

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
      return "Gemini Nano is not available in this browser, so this cannot run on-device.";
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

export function cloudStatusLine(chars: number): string {
  return `Sent ${chars.toLocaleString("en-US")} characters of redacted text to Firebase AI Logic (Gemini cloud). The placeholder map stayed in this browser.`;
}

export function cancelLine(action: "explain" | "draft"): string {
  const tip =
    action === "explain"
      ? "To stay on-device, try a shorter selection of the document (explain it in parts)."
      : "To stay on-device, try a shorter instruction, or a shorter selection of the document.";
  return `Kept in this browser. Nothing was sent. ${tip}`;
}
