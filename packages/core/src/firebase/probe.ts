// Gemini Nano availability probe (TECH-SPEC 2.3).
// This is a status probe, NOT inference. Never call LanguageModel.create() / prompt() in product code.

export const TEXT_OPTS = {
  expectedInputs: [{ type: "text" as const, languages: ["en"] }],
  expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

/** Resolves to "unavailable" | "downloadable" | "downloading" | "available". */
export async function probeNano(): Promise<string> {
  if (typeof LanguageModel === "undefined" || !LanguageModel.availability) {
    return "unavailable";
  }
  return LanguageModel.availability(TEXT_OPTS);
}
