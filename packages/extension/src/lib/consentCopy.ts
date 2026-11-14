// UI copy for the router + consent gate (ARCHITECTURE 3.3, 3.6, 4.2, 5). Pure functions:
// they take types, counts and reason codes only, never document text or matched values.
import type { EntityType, HardQuestionFamily, PreflightResult, RouteReason, TypeCount } from "@rtr/core";
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
  return `Blocked: the outgoing text still contains ${joinCounts(leaks)} from your document that should have been masked. Send is disabled; nothing will be sent.`;
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
