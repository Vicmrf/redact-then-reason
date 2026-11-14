import { describe, expect, it } from "vitest";
import {
  detectCreditCards,
  detectDeterministic,
  detectEmails,
  detectPhones,
  detectSSNs,
} from "../src/redaction/regex";

const texts = (ds: { text: string }[]) => ds.map((d) => d.text);

describe("EMAIL", () => {
  it("finds emails case-insensitively with exact offsets", () => {
    const s = "Write to Jane.Example@Example.COM or ops@example.org.";
    const ds = detectEmails(s);
    expect(texts(ds)).toEqual(["Jane.Example@Example.COM", "ops@example.org"]);
    for (const d of ds) expect(s.slice(d.start, d.end)).toBe(d.text);
    expect(ds.every((d) => d.type === "EMAIL" && d.source === "regex")).toBe(true);
  });

  it("ignores things that are not emails", () => {
    expect(detectEmails("user at example dot com, @handle, a@b")).toEqual([]);
  });
});

describe("CREDIT_CARD", () => {
  it("detects Luhn-valid cards with spaces, dashes or no separators", () => {
    const s = "a 4111 1111 1111 1111 b 5555-5555-5555-4444 c 378282246310005 d 3782 822463 10005";
    expect(texts(detectCreditCards(s))).toEqual([
      "4111 1111 1111 1111",
      "5555-5555-5555-4444",
      "378282246310005",
      "3782 822463 10005",
    ]);
  });

  it("rejects Luhn failures and short runs", () => {
    expect(detectCreditCards("card 4111 1111 1111 1112 and 1234 5678 9012")).toEqual([]);
  });

  it("finds a card inside a longer digit run that would otherwise be too long", () => {
    const ds = detectCreditCards("ref 2026 4242 4242 4242 4242");
    // Sweep #4 residue rule: the card-adjacent unclaimed group "2026" is masked with the card
    // (was ["4242 4242 4242 4242"]; over-masking is safe, a visible adjacent group is not).
    expect(texts(ds)).toEqual(["2026 4242 4242 4242 4242"]);
  });
});

describe("SSN", () => {
  it("detects dashed SSNs", () => {
    expect(texts(detectSSNs("SSN 078-05-1120 and 123-45-6789"))).toEqual(["078-05-1120", "123-45-6789"]);
  });

  it.each(["000-12-3456", "666-12-3456", "900-12-3456", "987-65-4321", "123-00-4567", "123-45-0000"])(
    "does not detect invalid range %s",
    (v) => expect(detectSSNs(`SSN: ${v}`)).toEqual([]),
  );

  it("detects unseparated 9 digits only with a nearby keyword", () => {
    expect(texts(detectSSNs("Your SSN is 123456789."))).toEqual(["123456789"]);
    expect(texts(detectSSNs("social security number: 078051120"))).toEqual(["078051120"]);
    expect(texts(detectSSNs("ITIN 123456789"))).toEqual(["123456789"]);
    expect(texts(detectSSNs("tin = 123456789"))).toEqual(["123456789"]);
    expect(texts(detectSSNs("Ssn on file 123456789"))).toEqual(["123456789"]);
  });

  it("does not detect unseparated 9 digits without a keyword", () => {
    expect(detectSSNs("Order number 123456789 shipped to zip 62704.")).toEqual([]);
    // "tin" must be a whole word: "routing" / "Martin" do not count.
    expect(detectSSNs("Martin's routing code 123456789")).toEqual([]);
  });

  it("does not detect invalid unseparated SSNs even with a keyword", () => {
    expect(detectSSNs("SSN 000123456")).toEqual([]);
    expect(detectSSNs("SSN 900123456")).toEqual([]);
  });
});

describe("PHONE", () => {
  it("detects NANP and international formats", () => {
    const s = "Call (202) 555-0143, +1 415-555-0199, 1-202-555-0177, 217.555.0161 or +44 20 7946 0958.";
    expect(texts(detectPhones(s))).toEqual([
      "(202) 555-0143",
      "+1 415-555-0199",
      "1-202-555-0177",
      "217.555.0161",
      "+44 20 7946 0958",
    ]);
  });

  it("post-filters to 10-15 digits", () => {
    expect(detectPhones("ext 555-0143 or claim 2026-0042")).toEqual([]);
  });
});

describe("detectDeterministic", () => {
  it("runs cards before phones so card fragments are never phones", () => {
    const s = "Card 4111 1111 1111 1111 and phone (202) 555-0143.";
    const ds = detectDeterministic(s);
    expect(ds.map((d) => [d.type, d.text])).toEqual([
      ["CREDIT_CARD", "4111 1111 1111 1111"],
      ["PHONE", "(202) 555-0143"],
    ]);
  });

  it("returns non-overlapping spans sorted by start", () => {
    const s = "jane@example.com 078-05-1120 5555 5555 5555 4444 +1 415-555-0199";
    const ds = detectDeterministic(s);
    // Sweep #4 residue rule: "078-05-1120 5555 5555 5555 4444" is one contiguous candidate digit
    // run, so the card-adjacent SSN groups are absorbed into the CREDIT_CARD span (still masked,
    // now typed CREDIT_CARD; was ["EMAIL", "SSN", "CREDIT_CARD", "PHONE"]).
    expect(ds.map((d) => d.type)).toEqual(["EMAIL", "CREDIT_CARD", "PHONE"]);
    expect(ds[1]!.text).toBe("078-05-1120 5555 5555 5555 4444");
    for (let i = 1; i < ds.length; i++) expect(ds[i]!.start).toBeGreaterThanOrEqual(ds[i - 1]!.end);
  });

  it("does not report an SSN as a phone", () => {
    expect(detectDeterministic("SSN 123-45-6789").map((d) => d.type)).toEqual(["SSN"]);
  });
});
