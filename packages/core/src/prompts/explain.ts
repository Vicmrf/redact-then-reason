// Explain-short-doc prompt (BUILD-PLAN Day 3) and the Day-3 router budget (ARCHITECTURE 3.6).
// Per ARCHITECTURE 4.1 the on-device explain may use the RAW text: it never leaves the device.

/** ARCHITECTURE 3.4 "Unmasking" step 1, verbatim. */
export const PLACEHOLDER_RULE =
  "Placeholders look like `[TYPE_N]`. Copy them verbatim. Do not invent values for them.";

/**
 * On-device input budget in tokens for document + question + prompt (ARCHITECTURE 3.6,
 * TECH-SPEC 3.5). The on-device max is 9216; ~2,000 are reserved for system prompt and output.
 */
export const ON_DEVICE_INPUT_BUDGET = 6000;

/** Documented heuristic: ~4 characters per token. Do not use countTokens() for routing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildExplainPrompt(doc: string): string {
  return [
    "Explain the document below to the person who received it, in plain language.",
    "Format:",
    "- First line exactly: \"What this is: <document type in a few words>\" (for example: medical email, tax notice, HR letter).",
    "- Then a short explanation: what it says, what the reader needs to do, and any deadlines or dates that matter.",
    "Be concise (under 150 words). Use short sentences. Do not add advice the document does not support.",
    PLACEHOLDER_RULE,
    "",
    "Document:",
    "<<<",
    doc,
    ">>>",
  ].join("\n");
}

/** True when the explain prompt for `doc` fits the on-device input budget. */
export function fitsOnDeviceBudget(prompt: string): boolean {
  return estimateTokens(prompt) <= ON_DEVICE_INPUT_BUDGET;
}
