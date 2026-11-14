// Draft-reply prompt (BUILD-PLAN Day 4). Single-turn only (no startChat: multi-turn is not
// supported on-device, ARCHITECTURE 4.3).
// Input is the REDACTED document (placeholders like [PERSON_1]): an explicit product choice,
// allowed by ARCHITECTURE 1 ("raw or redacted"). The panel unmasks the draft locally.
import { PLACEHOLDER_RULE, estimateTokens, ON_DEVICE_INPUT_BUDGET } from "./explain";

/** Max length of the optional user instruction (tone / goal). */
export const DRAFT_INSTRUCTION_MAX_CHARS = 300;

/** Generic outcome message; the UI decides whether to offer the consented cloud path. */
export const TOO_LONG_FOR_DRAFT = "Too long for on-device draft.";

/** Single line, trimmed, capped. Returns "" when there is no usable instruction. */
export function normalizeDraftInstruction(instruction: string | undefined | null): string {
  if (typeof instruction !== "string") return "";
  const oneLine = instruction.replace(/\s+/g, " ").trim();
  return oneLine.slice(0, DRAFT_INSTRUCTION_MAX_CHARS).trim();
}

export function buildDraftPrompt(redactedDoc: string, instruction?: string): string {
  const extra = normalizeDraftInstruction(instruction);
  return [
    "Write a short, polite reply that the person who received the document below could send back to its sender.",
    "Rules:",
    "- Output only the reply: a greeting, 2 to 5 short sentences, and a sign-off. No subject line, no notes, no explanations.",
    "- Respond to what the sender asks or says. Do not agree to anything the document does not ask for.",
    "- Do not make up facts, amounts, dates, or contact details.",
    "- To name someone, use the placeholder that appears in the document.",
    PLACEHOLDER_RULE,
    ...(extra ? ["", `The reader's instruction for this reply (tone or goal): ${extra}`] : []),
    "",
    "Document (redacted):",
    "<<<",
    redactedDoc,
    ">>>",
  ].join("\n");
}

/** Day-4 router guard (ARCHITECTURE 3.6): over budget means no model call at all. */
export function draftFitsOnDevice(prompt: string): boolean {
  return estimateTokens(prompt) <= ON_DEVICE_INPUT_BUDGET;
}
