// Router (ARCHITECTURE 3.6). Pure and generic: decides whether a request stays on-device or
// whether the cloud may be OFFERED. It never returns an automatic cloud route: the only way to
// the cloud is the consent gate (ARCHITECTURE 5), where the user clicks Send.
//
// Budget: documented heuristic ~4 characters per token (no countTokens(), TECH-SPEC 3.5),
// ON_DEVICE_INPUT_BUDGET = 6000 tokens for document + question + prompt boilerplate.
import { ON_DEVICE_INPUT_BUDGET, estimateTokensFromChars } from "../prompts/explain";

/** Stable reason codes. UI packages map them to their own copy. */
export type RouteReason =
  | "nano_unavailable"
  | "over_budget"
  | "user_requested_cloud"
  | "hard_question"
  | "on_device_failed";

/** Families of "hard" questions (ARCHITECTURE 3.6). */
export type HardQuestionFamily = "comparison" | "multi_hop" | "enumerate_all" | "inconsistencies" | "compute";

/**
 * Small, documented pattern list. Any match is enough to OFFER the cloud (never to send).
 * - comparison:      "compare", "versus" / "vs", "difference between", "which is better"
 * - multi_hop:       "cross-reference", "step by step", "relationship between", "based on ... then"
 * - enumerate_all:   "list every / all / each", "find all / every", "every mention / instance / occurrence"
 * - inconsistencies: "inconsistent / inconsistency / inconsistencies", "contradict(s/ion)", "discrepanc(y/ies)"
 * - compute:         "compute", "calculate", "total", "sum of", "add up", "average", "percentage"
 */
export const HARD_QUESTION_PATTERNS: ReadonlyArray<{ family: HardQuestionFamily; re: RegExp }> = [
  { family: "comparison", re: /\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|differences?\s+between|which\s+(?:one\s+)?is\s+(?:better|cheaper|larger|smaller))\b/i },
  { family: "multi_hop", re: /\b(?:cross[-\s]?reference|step[-\s]by[-\s]step|relationship\s+between|based\s+on\b[\s\S]+\bthen)\b/i },
  { family: "enumerate_all", re: /\b(?:list\s+(?:every|all|each)|find\s+(?:all|every)|every\s+(?:mention|instance|occurrence))\b/i },
  { family: "inconsistencies", re: /\b(?:inconsisten(?:t|cy|cies)|contradict(?:s|ion|ions|ory)?|discrepanc(?:y|ies))\b/i },
  { family: "compute", re: /\b(?:compute|calculate|calculation|total|sum\s+of|add\s+up|average|percentage)\b/i },
];

/** Classification copy of a question: NFKC, every whitespace run (incl. newlines) -> one space. */
function normalizeQuestion(question: string): string {
  return question.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function classifyHardQuestion(question: string | undefined | null): HardQuestionFamily[] {
  if (typeof question !== "string") return [];
  const q = normalizeQuestion(question);
  if (q === "") return [];
  return HARD_QUESTION_PATTERNS.filter((p) => p.re.test(q)).map((p) => p.family);
}

export interface RouteInput {
  /** Length of the redacted document (what the cloud would receive). */
  redactedChars: number;
  /** Length of the raw document, when the on-device path would use the raw text (it never leaves the device). */
  rawChars?: number;
  /** The user's question / instruction (may be empty). */
  question?: string;
  /** Prompt boilerplate around the document and question, in characters. */
  overheadChars?: number;
  /** False only when the availability probe says on-device inference is unavailable. */
  nanoAvailable: boolean;
  /** The user explicitly asked for a deeper (cloud) answer. Still goes through consent. */
  userRequestedCloud?: boolean;
  /** The on-device call threw, or returned an empty / blocked response. */
  onDeviceFailed?: boolean;
}

export type RouteDecision =
  | { route: "on_device"; estimatedTokens: number }
  | {
      route: "offer_cloud";
      reasons: RouteReason[];
      hardQuestion: HardQuestionFamily[];
      estimatedTokens: number;
    };

/** Estimated on-device input tokens: (document the on-device path would see + question + overhead) / 4. */
export function estimateOnDeviceTokens(input: RouteInput): number {
  const doc = input.rawChars ?? input.redactedChars;
  const q = input.question?.length ?? 0;
  return estimateTokensFromChars(Math.max(0, doc) + q + Math.max(0, input.overheadChars ?? 0));
}

/**
 * ARCHITECTURE 3.6. Returns "on_device" only when every condition for local inference holds;
 * otherwise "offer_cloud" with stable reason codes. There is deliberately no auto-cloud route.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const estimatedTokens = estimateOnDeviceTokens(input);
  const hardQuestion = classifyHardQuestion(input.question);
  const reasons: RouteReason[] = [];
  if (!input.nanoAvailable) reasons.push("nano_unavailable");
  if (estimatedTokens > ON_DEVICE_INPUT_BUDGET) reasons.push("over_budget");
  if (input.userRequestedCloud) reasons.push("user_requested_cloud");
  if (hardQuestion.length > 0) reasons.push("hard_question");
  if (input.onDeviceFailed) reasons.push("on_device_failed");
  if (reasons.length === 0) return { route: "on_device", estimatedTokens };
  return { route: "offer_cloud", reasons, hardQuestion, estimatedTokens };
}
