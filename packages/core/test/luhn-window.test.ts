// Sweep decision #4: cross-line Luhn pairing leak in detectCreditCards. All PANs are public test
// numbers; all other digits are synthetic.
import { describe, expect, it } from "vitest";
import { checkCloudSend } from "../src/consent/leaks";
import { buildCloudPayload } from "../src/consent/payload";
import { preflightCheck } from "../src/consent/preflight";
import { luhnOk } from "../src/redaction/luhn";
import { redact, redactWithLlm } from "../src/redaction/redact";
import { detectCreditCards, detectHighRisk } from "../src/redaction/regex";
import type { Detection } from "../src/types";

const PAN = "4111 1111 1111 1111";
const PAN_DIGITS = PAN.replace(/\D/g, "");
/** Masked text with placeholder tokens removed: what digits are still visible. */
const visibleDigits = (masked: string) => masked.replace(/\[[A-Z_]+_\d+\]/g, "").replace(/\D/g, "");

describe("Luhn window: an unrelated previous-line group cannot steal a card's leading groups", () => {
  // G = 1004: "1004" + "4111 1111 1111" is 16 digits and passes Luhn.
  // OLD behaviour: the window search started at G, took G + the PAN's first three groups as the
  // card ("1004\n4111 1111 1111" -> [CREDIT_CARD_1]) and left the trailing "1111" visible
  // ("Ref [CREDIT_CARD_1] 1111 thanks"). preflightCheck(masked) then passed (only 4 loose digits),
  // so raw PAN digits reached the cloud payload.
  const G = "1004";
  const raw = `Ref ${G}\n${PAN} thanks`;

  it("precondition: G + the PAN's leading groups is a 13-19 digit Luhn-valid window", () => {
    const window = G + "411111111111";
    expect(window.length).toBeGreaterThanOrEqual(13);
    expect(window.length).toBeLessThanOrEqual(19);
    expect(luhnOk(window)).toBe(true);
    expect(luhnOk(PAN_DIGITS)).toBe(true);
  });

  it("the full PAN is inside one CREDIT_CARD detection (residue G is over-masked)", () => {
    const d = detectCreditCards(raw);
    expect(d).toHaveLength(1);
    const panStart = raw.indexOf(PAN);
    expect(d[0]!.start).toBeLessThanOrEqual(panStart);
    expect(d[0]!.end).toBeGreaterThanOrEqual(panStart + PAN.length);
    expect(d[0]!.text).toBe(`${G}\n${PAN}`);
    expect(raw.slice(d[0]!.start, d[0]!.end)).toBe(d[0]!.text);
  });

  it("redact / redactWithLlm leave none of the PAN's groups visible; preflight blocks raw, passes masked", () => {
    const s = raw.indexOf("thanks");
    const llm: Detection[] = [{ type: "OTHER", start: s, end: s + 6, text: "thanks", source: "llm" }];
    for (const out of [redact(raw), redactWithLlm(raw, llm)]) {
      expect(out.masked).toContain("[CREDIT_CARD_1]");
      expect(out.masked).not.toMatch(/4111|1111/);
      expect(out.masked).not.toMatch(/\[CREDIT_CARD_1\][ \t\r\n]*\d/);
      expect(visibleDigits(out.masked)).toBe("");
      expect(detectHighRisk(out.masked).filter((x) => x.type === "CREDIT_CARD")).toEqual([]);
      expect(preflightCheck(out.masked).ok).toBe(true);
    }
    expect(preflightCheck(raw).ok).toBe(false);
  });

  it("checkCloudSend passes on the masked-doc payload only because the PAN is masked", () => {
    const { masked, map } = redact(raw);
    const good = buildCloudPayload(masked, { kind: "explain" });
    expect(good.text).not.toMatch(/4111|1111/);
    expect(checkCloudSend(good.text, map, "complete").ok).toBe(true);
    const bad = buildCloudPayload(raw, { kind: "explain" });
    const check = checkCloudSend(bad.text, map, "complete");
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("preflight");
  });
});

describe("Luhn window: line handling", () => {
  it("a PAN wrapped across two lines is still one card", () => {
    const t = "Card 4111 1111\n1111 1111 ok";
    const d = detectCreditCards(t);
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe("4111 1111\n1111 1111");
    expect(redact(t).masked).toBe("Card [CREDIT_CARD_1] ok");
  });

  it("two separate cards on consecutive lines are both detected (no merge)", () => {
    const t = "4111 1111 1111 1111\n5555 5555 5555 4444";
    expect(luhnOk("5555555555554444")).toBe(true);
    const d = detectCreditCards(t);
    expect(d.map((x) => x.text)).toEqual(["4111 1111 1111 1111", "5555 5555 5555 4444"]);
    expect(visibleDigits(redact(t).masked)).toBe("");
  });

  it("a trailing same-line group after a card never stays visible (residue rule)", () => {
    // Same-line variant of the bypass: G + first three groups pass Luhn on one line.
    const t = `x 1004 ${PAN} y`;
    const d = detectCreditCards(t);
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe(`1004 ${PAN}`);
    expect(visibleDigits(redact(t).masked)).toBe("");
  });

  it("table of short numbers next to a card: labelled rows stay, an unlabelled numeric block is over-masked", () => {
    // Labelled rows: letters break the candidate run, so only the card is masked.
    const labelled = `Qty 12\nCard ${PAN}\nRoom 42`;
    expect(redact(labelled).masked).toBe("Qty 12\nCard [CREDIT_CARD_1]\nRoom 42");
    // Pure numeric block: "12 34" / PAN / "56 78" form ONE candidate digit run (single-space and
    // single-newline separators). The card is found on its own line; the residue rule then masks the
    // whole contiguous run. Documented over-masking: 12, 34, 56, 78 are masked too.
    const block = `Totals\n12 34\n${PAN}\n56 78\nend`;
    const d = detectCreditCards(block);
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe(`12 34\n${PAN}\n56 78`);
    expect(redact(block).masked).toBe("Totals\n[CREDIT_CARD_1]\nend");
  });

  it("non-card numeric lines are untouched (no Luhn match, no residue rule)", () => {
    // Only 16-digit (4-group) windows are in range; neither passes Luhn.
    const t = "1234 5678\n9012 3456 7891";
    expect(luhnOk("1234567890123456")).toBe(false);
    expect(luhnOk("5678901234567891")).toBe(false);
    expect(detectCreditCards(t)).toEqual([]);
    // (The trailing 12 digits are still masked as a PHONE by the later detector; no CREDIT_CARD.)
    expect(redact(t).masked).not.toContain("CREDIT_CARD");
    expect(redact(t).masked.startsWith("1234 5678\n")).toBe(true);
  });
});
