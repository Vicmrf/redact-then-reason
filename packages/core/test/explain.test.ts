import { describe, expect, it } from "vitest";
import {
  buildExplainPrompt,
  estimateTokens,
  fitsOnDeviceBudget,
  ON_DEVICE_INPUT_BUDGET,
  PLACEHOLDER_RULE,
} from "../src/prompts/explain";

describe("explain prompt", () => {
  const p = buildExplainPrompt("SYNTHETIC LETTER BODY");

  it("asks for the document type first line and a plain explanation", () => {
    expect(p).toContain('"What this is: <document type in a few words>"');
    expect(p).toMatch(/medical email, tax notice, HR letter/);
    expect(p).toMatch(/what the reader needs to do/);
    expect(p).toMatch(/deadlines/);
    expect(p).toMatch(/concise/i);
  });

  it("includes the placeholder rule and the document", () => {
    expect(PLACEHOLDER_RULE).toBe(
      "Placeholders look like `[TYPE_N]`. Copy them verbatim. Do not invent values for them.",
    );
    expect(p).toContain(PLACEHOLDER_RULE);
    expect(p).toContain("SYNTHETIC LETTER BODY");
  });
});

describe("token budget", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(24_000))).toBe(6000);
  });

  it("budget is 6000 tokens and the router check uses it", () => {
    expect(ON_DEVICE_INPUT_BUDGET).toBe(6000);
    expect(fitsOnDeviceBudget("x".repeat(24_000))).toBe(true);
    expect(fitsOnDeviceBudget("x".repeat(24_001))).toBe(false);
    expect(fitsOnDeviceBudget(buildExplainPrompt("short doc"))).toBe(true);
    expect(fitsOnDeviceBudget(buildExplainPrompt("y".repeat(24_000)))).toBe(false);
  });
});
