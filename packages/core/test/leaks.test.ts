// Day 5 follow-up: every-occurrence masking + placeholder-map leak check before cloud.
// Pure modules only (no firebase import). All PII is synthetic.
import { describe, expect, it } from "vitest";
import { expandToAllOccurrences, findOccurrences } from "../src/redaction/occurrences";
import { redactWithLlm } from "../src/redaction/redact";
import { verifyLlmSpans } from "../src/redaction/llmExtract";
import { buildCloudPayload } from "../src/consent/payload";
import { MapLeakError, assertNoMapLeaks, checkCloudSend, findMapLeaks } from "../src/consent/leaks";
import { EntityPassIncompleteError, assertEntityPassComplete, toEntityPassStatus } from "../src/consent/entityPass";
import type { PlaceholderMap } from "../src/types";

const OPTS = { docId: "test-doc", createdAt: 0 };

describe("findOccurrences", () => {
  it("finds every exact, case-sensitive occurrence", () => {
    expect(findOccurrences("Jane Testperson met jane testperson and Jane Testperson.", "Jane Testperson")).toEqual([0, 40]);
  });

  it("respects word boundaries: 'Ann' does not match inside 'Annual' or 'Joann'", () => {
    const src = "Annual review for Ann. Joann said Ann's form, (Ann).";
    const hits = findOccurrences(src, "Ann");
    expect(hits.map((i) => src.slice(i - 1, i + 4))).toEqual([" Ann.", " Ann'", "(Ann)"]);
  });

  it("uses unicode letter classes for boundaries", () => {
    expect(findOccurrences("Zoë Zoëlle Zoë", "Zoë")).toEqual([0, 11]);
    expect(findOccurrences("ÅAnn Ann", "Ann")).toEqual([5]);
  });

  it("does not require boundaries on non-word edges", () => {
    // Left edge "#" is not a word char, so "x#" is fine; right edge "1" still needs a boundary.
    expect(findOccurrences("x#TEST-0001 x#TEST-0001y", "#TEST-0001")).toEqual([1]);
  });
});

describe("expandToAllOccurrences / redactWithLlm", () => {
  const raw = "Jane Testperson called. Later Jane Testperson wrote back. Regards, Jane Testperson.";

  it("LLM listing a name once still masks all 3 occurrences with the same [PERSON_1]", () => {
    const llm = verifyLlmSpans(raw, [{ type: "PERSON", text: "Jane Testperson" }]);
    expect(llm).toHaveLength(1);
    const res = redactWithLlm(raw, llm, OPTS);
    expect(res.masked).toBe("[PERSON_1] called. Later [PERSON_1] wrote back. Regards, [PERSON_1].");
    expect(res.masked).not.toContain("Jane");
    expect(res.map.entries).toHaveLength(1);
    expect(res.map.entries[0]!.token).toBe("[PERSON_1]");
    expect(res.counts).toEqual([{ type: "PERSON", count: 3 }]);
  });

  it("'Ann' does not mask inside 'Annual'", () => {
    const src = "Annual summary for Ann. Ann signed the Annual form.";
    const res = redactWithLlm(src, verifyLlmSpans(src, [{ type: "PERSON", text: "Ann" }]), OPTS);
    expect(res.masked).toBe("Annual summary for [PERSON_1]. [PERSON_1] signed the Annual form.");
  });

  it("skips expansion for texts with fewer than 2 non-space chars but keeps the listed span", () => {
    const src = "J and J and J";
    const det = verifyLlmSpans(src, [{ type: "OTHER", text: "J" }]);
    expect(expandToAllOccurrences(src, det)).toEqual(det);
  });

  it("regex spans still win on overlap after expansion", () => {
    const src = "Mail jane.testperson@example.test or ask jane.testperson in person.";
    const llm = verifyLlmSpans(src, [{ type: "PERSON", text: "jane.testperson" }]);
    const res = redactWithLlm(src, llm, OPTS);
    expect(res.masked).toBe("Mail [EMAIL_1] or ask [PERSON_1] in person.");
  });

  it("does not mutate the input detections", () => {
    const det = verifyLlmSpans(raw, [{ type: "PERSON", text: "Jane Testperson" }]);
    const copy = JSON.parse(JSON.stringify(det));
    expandToAllOccurrences(raw, det);
    expect(det).toEqual(copy);
  });
});

function mapOf(entries: Array<[PlaceholderMap["entries"][number]["type"], string]>): PlaceholderMap {
  return {
    docId: "d",
    createdAt: 0,
    entries: entries.map(([type, original], i) => ({ token: `[${type}_${i + 1}]`, type, original, start: 0, end: original.length })),
  };
}

describe("findMapLeaks / assertNoMapLeaks / checkCloudSend", () => {
  it("detects a residual original and returns counts by type only", () => {
    const map = mapOf([
      ["PERSON", "Jane Testperson"],
      ["PERSON", "John Testperson"],
      ["ORG", "Acme Test Clinic"],
    ]);
    const leaks = findMapLeaks("[PERSON_1] met Jane Testperson at Acme Test Clinic.", map);
    expect(leaks).toEqual([
      { type: "PERSON", count: 1 },
      { type: "ORG", count: 1 },
    ]);
    expect(JSON.stringify(leaks)).not.toMatch(/Jane|Acme/);
  });

  it("ignores originals shorter than 2 chars after trim and respects word boundaries", () => {
    const map = mapOf([["OTHER", " J "], ["PERSON", "Ann"]]);
    expect(findMapLeaks("J says the Annual report is due.", map)).toEqual([]);
    expect(findMapLeaks("Ask Ann.", map)).toEqual([{ type: "PERSON", count: 1 }]);
  });

  it("compares emails case-insensitively", () => {
    const map = mapOf([["EMAIL", "jane.testperson@example.test"]]);
    expect(findMapLeaks("Write to JANE.TESTPERSON@EXAMPLE.TEST", map)).toEqual([{ type: "EMAIL", count: 1 }]);
  });

  it("assertNoMapLeaks throws MapLeakError with counts only; message has no originals", () => {
    const map = mapOf([["PERSON", "Jane Testperson"]]);
    expect(() => assertNoMapLeaks("[PERSON_1] is fine", map)).not.toThrow();
    let err: unknown;
    try {
      assertNoMapLeaks("Jane Testperson leaked", map);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MapLeakError);
    expect((err as MapLeakError).hits).toEqual([{ type: "PERSON", count: 1 }]);
    expect((err as Error).message).not.toContain("Jane");
  });

  it("checkCloudSend refuses when a leak exists even if pre-flight passes", () => {
    const map = mapOf([["PERSON", "Jane Testperson"]]);
    const leaky = checkCloudSend("Explain this for Jane Testperson.", map, "complete");
    expect(leaky.preflight.ok).toBe(true);
    expect(leaky.leaks).toEqual([{ type: "PERSON", count: 1 }]);
    expect(leaky.ok).toBe(false);
    expect(leaky.reasons).toEqual(["map_leak"]);

    const blockedPreflight = checkCloudSend("[PERSON_1] at jane.testperson@example.test", map, "complete");
    expect(blockedPreflight.ok).toBe(false);
    expect(blockedPreflight.reasons).toContain("preflight");

    const clean = checkCloudSend("Explain this for [PERSON_1].", map, "complete");
    expect(clean.ok).toBe(true);
    expect(clean.reasons).toEqual([]);
    expect(clean.entityPass).toBe("complete");
  });

  it("checkCloudSend fails closed unless the entity pass is complete (clean payload)", () => {
    const map = mapOf([["PERSON", "Jane Testperson"]]);
    const payload = "Explain this for [PERSON_1].";
    for (const status of ["pending", "skipped_too_long", "unavailable", "failed", undefined] as const) {
      const res = checkCloudSend(payload, map, status);
      expect(res.ok).toBe(false);
      expect(res.reasons).toEqual(["entity_pass_incomplete"]);
      expect(res.preflight.ok).toBe(true);
      expect(res.leaks).toEqual([]);
    }
    expect(checkCloudSend(payload, map, undefined).entityPass).toBe("pending");
    // Unrecognized value (e.g. a corrupted stored record) also blocks.
    expect(checkCloudSend(payload, map, "COMPLETE" as never).ok).toBe(false);
  });

  it("assertEntityPassComplete throws a typed error carrying only the status", () => {
    expect(() => assertEntityPassComplete("complete")).not.toThrow();
    for (const status of ["pending", "skipped_too_long", "unavailable", "failed", undefined, null, "x"]) {
      let err: unknown;
      try {
        assertEntityPassComplete(status);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EntityPassIncompleteError);
      expect((err as EntityPassIncompleteError).status).toBe(toEntityPassStatus(status));
      expect(Object.keys(err as object)).not.toContain("payload");
    }
    expect(toEntityPassStatus("failed")).toBe("failed");
    expect(toEntityPassStatus(undefined)).toBe("pending");
  });

  it("buildCloudPayload for a doc with repeated names has no map originals", () => {
    const raw =
      "Dear Jane Testperson, Acme Test Clinic confirms your visit. Jane Testperson, bring your card. " +
      "Contact Acme Test Clinic at desk@acme-clinic.test. Signed for Jane Testperson.";
    const llm = verifyLlmSpans(raw, [
      { type: "PERSON", text: "Jane Testperson" },
      { type: "ORG", text: "Acme Test Clinic" },
    ]);
    const { masked, map } = redactWithLlm(raw, llm, OPTS);
    for (const action of [{ kind: "explain" as const }, { kind: "draft" as const, instruction: "Reply politely" }]) {
      const payload = buildCloudPayload(masked, action);
      expect(findMapLeaks(payload.text, map)).toEqual([]);
      for (const e of map.entries) expect(payload.text).not.toContain(e.original);
      expect(() => assertNoMapLeaks(payload.text, map)).not.toThrow();
      expect(checkCloudSend(payload.text, map, "complete").ok).toBe(true);
    }
  });
});
