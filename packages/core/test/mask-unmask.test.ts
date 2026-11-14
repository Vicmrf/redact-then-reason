import { describe, expect, it } from "vitest";
import { mask } from "../src/redaction/mask";
import { unmask, SUSPECT_TOKEN } from "../src/redaction/unmask";
import { redact } from "../src/redaction/redact";
import type { Detection, PlaceholderMap } from "../src/types";

const SAMPLE =
  "Hi, I'm reachable at jane.example@example.com or (202) 555-0143. " +
  "Card 4111 1111 1111 1111, SSN 078-05-1120. Again: jane.example@example.com.";

describe("mask", () => {
  it("replaces spans with typed placeholders numbered per type", () => {
    const { masked, map } = redact(SAMPLE, { docId: "doc-1", createdAt: 1 });
    expect(masked).toBe(
      "Hi, I'm reachable at [EMAIL_1] or [PHONE_1]. Card [CREDIT_CARD_1], SSN [SSN_1]. Again: [EMAIL_1].",
    );
    expect(map.docId).toBe("doc-1");
    expect(map.createdAt).toBe(1);
    expect(map.entries.map((e) => e.token)).toEqual(["[EMAIL_1]", "[PHONE_1]", "[CREDIT_CARD_1]", "[SSN_1]"]);
  });

  it("reuses one token for duplicate values and numbers distinct values", () => {
    const s = "a@example.com b@example.org a@example.com A@EXAMPLE.COM";
    const { masked, map } = redact(s);
    expect(masked).toBe("[EMAIL_1] [EMAIL_2] [EMAIL_1] [EMAIL_1]");
    expect(map.entries).toHaveLength(2);
    expect(map.entries[0]!.original).toBe("a@example.com");
  });

  it("reuses tokens for duplicate LLM-style names", () => {
    const s = "Jane Doe met Sam Roe. Jane Doe left.";
    const d = (start: number, end: number): Detection => ({ type: "PERSON", start, end, text: s.slice(start, end), source: "llm" });
    const { masked, map } = mask(s, [d(0, 8), d(13, 20), d(22, 30)]);
    expect(masked).toBe("[PERSON_1] met [PERSON_2]. [PERSON_1] left.");
    expect(map.entries.map((e) => [e.token, e.original])).toEqual([
      ["[PERSON_1]", "Jane Doe"],
      ["[PERSON_2]", "Sam Roe"],
    ]);
  });

  it("generates a docId when none is given", () => {
    const a = redact("x@example.com").map.docId;
    const b = redact("x@example.com").map.docId;
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("refuses overlapping or out-of-range detections", () => {
    const d = (start: number, end: number): Detection => ({ type: "OTHER", start, end, text: "", source: "llm" });
    expect(() => mask("abcdefgh", [d(0, 4), d(2, 6)])).toThrow(/overlapping/);
    expect(() => mask("abc", [d(0, 10)])).toThrow(RangeError);
  });
});

describe("unmask", () => {
  it("round-trips mask -> unmask exactly", () => {
    const { masked, map } = redact(SAMPLE);
    const res = unmask(masked, map);
    expect(res.text).toBe(SAMPLE);
    expect(res.suspects).toBe(0);
  });

  it("does not interpret $1, $&, $` or regex characters in originals", () => {
    const tricky = "J$1 $& $` $' $$ (.*)+?[a-z]\\d{3}|^$";
    const map: PlaceholderMap = {
      docId: "d",
      createdAt: 0,
      entries: [{ token: "[PERSON_1]", type: "PERSON", original: tricky, start: 0, end: tricky.length }],
    };
    const res = unmask("Dear [PERSON_1], hi [PERSON_1].", map);
    expect(res.text).toBe(`Dear ${tricky}, hi ${tricky}.`);
    expect(res.suspects).toBe(0);
  });

  it("does not confuse [EMAIL_1] with [EMAIL_10]", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      token: `[EMAIL_${i + 1}]`,
      type: "EMAIL" as const,
      original: `u${i + 1}@example.com`,
      start: 0,
      end: 1,
    }));
    const res = unmask("[EMAIL_10] [EMAIL_1]", { docId: "d", createdAt: 0, entries });
    expect(res.text).toBe("u10@example.com u1@example.com");
  });

  it("leaves unknown tokens and plain text untouched", () => {
    const { map } = redact("a@example.com");
    expect(unmask("See [EMAIL_9] and [PHONE_1].", map).text).toBe("See [EMAIL_9] and [PHONE_1].");
  });

  it("replaces model-invented email / SSN / card with [REDACTED_SUSPECT]", () => {
    const { map } = redact("Contact a@example.com");
    const modelOutput =
      "Reply to [EMAIL_1]. Also cc invented@example.net, SSN 123-45-6789, card 5555 5555 5555 4444.";
    const res = unmask(modelOutput, map);
    expect(res.suspects).toBe(3);
    expect(res.text).toBe(
      `Reply to a@example.com. Also cc ${SUSPECT_TOKEN}, SSN ${SUSPECT_TOKEN}, card ${SUSPECT_TOKEN}.`,
    );
    expect(res.text).not.toContain("invented@example.net");
  });

  it("flags a substituted original that the model extended into a new identifier", () => {
    const { map } = redact("Contact a@example.com");
    // "[EMAIL_1]" followed by ".evil.example.net" produces an email that is not wholly from the map.
    const res = unmask("<[EMAIL_1]>", map);
    expect(res.suspects).toBe(0);
    expect(res.text).toBe("<a@example.com>");
    const res2 = unmask("mail [EMAIL_1].evil.example.net now", map);
    expect(res2.suspects).toBe(1);
    expect(res2.text).not.toContain("evil");
  });
});
