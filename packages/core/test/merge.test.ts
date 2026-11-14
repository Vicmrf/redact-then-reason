import { describe, expect, it } from "vitest";
import { mergeDetections } from "../src/redaction/merge";
import type { Detection } from "../src/types";

const det = (type: Detection["type"], start: number, end: number, source: Detection["source"] = "regex"): Detection => ({
  type,
  start,
  end,
  text: "x".repeat(end - start),
  source,
});

describe("mergeDetections", () => {
  it("sorts by start and keeps disjoint spans", () => {
    const out = mergeDetections([det("PHONE", 20, 30), det("EMAIL", 0, 10)]);
    expect(out.map((d) => d.start)).toEqual([0, 20]);
  });

  // Codex 4: losing LLM spans keep their uncovered parts (the winner itself is unchanged).
  it("longest wins on overlap among same-priority spans; the losers' uncovered parts stay masked", () => {
    const out = mergeDetections([det("PERSON", 0, 5, "llm"), det("ADDRESS", 3, 20, "llm"), det("ORG", 18, 22, "llm")]);
    expect(out.map((d) => [d.type, d.start, d.end])).toEqual([
      ["PERSON", 0, 3],
      ["ADDRESS", 3, 20],
      ["ORG", 20, 22],
    ]);
  });

  it("a regex EMAIL beats a longer overlapping LLM OTHER; the rest of the OTHER stays masked", () => {
    const out = mergeDetections([det("OTHER", 0, 40, "llm"), det("EMAIL", 10, 26, "regex")]);
    expect(out.map((d) => [d.type, d.source, d.start, d.end])).toEqual([
      ["OTHER", "llm", 0, 10],
      ["EMAIL", "regex", 10, 26],
      ["OTHER", "llm", 26, 40],
    ]);
  });

  it("a regex deterministic span beats an LLM span of the same deterministic type", () => {
    const out = mergeDetections([det("MRN", 0, 12, "llm"), det("SSN", 2, 13, "regex")]);
    expect(out.map((d) => [d.type, d.source, d.start, d.end])).toEqual([
      ["MRN", "llm", 0, 2],
      ["SSN", "regex", 2, 13],
    ]);
  });

  it("Codex 4: ADDRESS containing an email -> street part masked as ADDRESS, email as EMAIL", async () => {
    const { redactWithLlm } = await import("../src/redaction/redact");
    const raw = "Send it to 12 Testing Lane, jane.t@example.test please.";
    const text = "12 Testing Lane, jane.t@example.test";
    const start = raw.indexOf(text);
    const out = redactWithLlm(raw, [{ type: "ADDRESS", start, end: start + text.length, text, source: "llm" }], {
      docId: "d",
      createdAt: 0,
    });
    expect(out.masked).toBe("Send it to [ADDRESS_1], [EMAIL_1] please.");
    expect(out.map.entries.map((e) => [e.type, e.original])).toEqual([
      ["ADDRESS", "12 Testing Lane"],
      ["EMAIL", "jane.t@example.test"],
    ]);
  });

  it("residual parts with no letter or digit are dropped (punctuation / spaces only)", () => {
    const src = "Jane, a@b.co";
    const out = mergeDetections([
      { type: "OTHER", start: 4, end: 12, text: src.slice(4, 12), source: "llm" },
      { type: "EMAIL", start: 6, end: 12, text: src.slice(6, 12), source: "regex" },
    ]);
    expect(out.map((d) => d.type)).toEqual(["EMAIL"]);
  });

  it("keeps non-overlapping LLM spans next to regex spans", () => {
    const out = mergeDetections([det("PERSON", 0, 8, "llm"), det("EMAIL", 10, 26)]);
    expect(out.map((d) => d.type)).toEqual(["PERSON", "EMAIL"]);
  });

  it("drops empty or invalid spans and does not mutate input", () => {
    const input = [det("EMAIL", 5, 5), det("PHONE", -1, 4), det("SSN", 0, 11)];
    const copy = structuredClone(input);
    expect(mergeDetections(input).map((d) => d.type)).toEqual(["SSN"]);
    expect(input).toEqual(copy);
  });
});
