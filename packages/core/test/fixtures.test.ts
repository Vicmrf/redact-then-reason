import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redact } from "../src/redaction/redact";
import { unmask } from "../src/redaction/unmask";
import { preflightCheck } from "../src/consent/preflight";
import type { EntityType } from "../src/types";

const TESTDATA = fileURLToPath(new URL("../../../testdata/", import.meta.url));

// Minimum occurrences per type each synthetic fixture is written to contain.
const FIXTURES: Record<string, Partial<Record<EntityType, number>>> = {
  "medical-email.txt": { EMAIL: 3, PHONE: 2, CREDIT_CARD: 1 },
  "tax-notice.txt": { EMAIL: 1, PHONE: 1, CREDIT_CARD: 1, SSN: 2 },
  "hr-benefits.txt": { EMAIL: 4, PHONE: 2, CREDIT_CARD: 1, SSN: 1 },
  "lease-excerpt.txt": { EMAIL: 4, PHONE: 2, CREDIT_CARD: 1, SSN: 1 },
};

describe.each(Object.entries(FIXTURES))("fixture %s", (file, expected) => {
  const original = readFileSync(TESTDATA + file, "utf8");
  const { masked, map, counts } = redact(original, { docId: file });

  it("detects the expected identifier types", () => {
    const got = Object.fromEntries(counts.map((c) => [c.type, c.count]));
    for (const [type, n] of Object.entries(expected)) expect(got[type]).toBe(n);
  });

  it("masked output passes pre-flight and contains no originals", () => {
    expect(preflightCheck(masked).ok).toBe(true);
    for (const e of map.entries) expect(masked).not.toContain(e.original);
  });

  it("round-trips exactly through unmask", () => {
    const res = unmask(masked, map);
    expect(res.suspects).toBe(0);
    expect(res.text).toBe(original);
  });

  it("does not flag negative SSN examples", () => {
    for (const e of map.entries.filter((x) => x.type === "SSN")) {
      expect(e.original).not.toMatch(/^(000|666|9\d\d)/);
    }
  });
});
