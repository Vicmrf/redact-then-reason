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

  it("longest wins on overlap among same-priority spans", () => {
    const out = mergeDetections([det("PERSON", 0, 5, "llm"), det("ADDRESS", 3, 20, "llm"), det("ORG", 18, 22, "llm")]);
    expect(out.map((d) => d.type)).toEqual(["ADDRESS"]);
  });

  it("a regex EMAIL beats a longer overlapping LLM OTHER", () => {
    const out = mergeDetections([det("OTHER", 0, 40, "llm"), det("EMAIL", 10, 26, "regex")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("EMAIL");
    expect(out[0]!.source).toBe("regex");
  });

  it("a regex deterministic span beats an LLM span of the same deterministic type", () => {
    const out = mergeDetections([det("MRN", 0, 12, "llm"), det("SSN", 2, 13, "regex")]);
    expect(out.map((d) => [d.type, d.source])).toEqual([["SSN", "regex"]]);
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
