// Day 5: consent-gate / router copy helpers. Pure; types, counts and reason codes only.
import { describe, expect, it } from "vitest";
import {
  CONSENT_DESTINATION,
  CONSENT_TITLE,
  SEND_LABEL,
  cancelLine,
  cloudStatusLine,
  consentCountsLine,
  countNoun,
  leakLine,
  maskedSummaryLine,
  preflightLine,
  reasonLine,
} from "../src/lib/consentCopy";

describe("consent copy", () => {
  it("uses the exact ARCHITECTURE 5 strings", () => {
    expect(CONSENT_TITLE).toBe("Send a redacted copy to the cloud?");
    expect(CONSENT_DESTINATION).toBe("Firebase AI Logic / Gemini Developer API. The placeholder map is not included.");
    expect(SEND_LABEL).toBe("Send redacted text to cloud");
  });

  it("maps types to plain-English nouns with plurals", () => {
    expect(countNoun("PERSON", 12)).toBe("12 names");
    expect(countNoun("PERSON", 1)).toBe("1 name");
    expect(countNoun("EMAIL", 3)).toBe("3 emails");
    expect(countNoun("SSN", 1)).toBe("1 SSN");
    expect(countNoun("CREDIT_CARD", 2)).toBe("2 card numbers");
    expect(countNoun("PHONE", 1)).toBe("1 phone number");
    expect(countNoun("ADDRESS", 2)).toBe("2 addresses");
  });

  it("builds the masked summary + pre-flight counts line", () => {
    const masked = [
      { type: "PERSON" as const, count: 12 },
      { type: "EMAIL" as const, count: 3 },
      { type: "SSN" as const, count: 1 },
    ];
    expect(maskedSummaryLine(masked)).toBe("12 names, 3 emails, 1 SSN masked.");
    expect(maskedSummaryLine([])).toBe("Nothing was masked.");
    expect(consentCountsLine(masked, { ok: true, hits: [] })).toBe(
      "12 names, 3 emails, 1 SSN masked. 0 unmasked emails/SSNs/cards/phones detected in the outgoing text.",
    );
  });

  it("reports blocking pre-flight hits by type and count only", () => {
    const line = preflightLine({
      ok: false,
      hits: [
        { type: "EMAIL", count: 2 },
        { type: "PHONE", count: 1 },
        { type: "ACCOUNT", count: 4 }, // non-blocking types are not listed
      ],
    });
    expect(line).toBe("Blocked: the outgoing text still contains 2 emails, 1 phone number. Send is disabled; nothing will be sent.");
  });

  it("reports placeholder-map leaks by type and count only", () => {
    expect(leakLine([])).toBe("");
    expect(
      leakLine([
        { type: "PERSON", count: 2 },
        { type: "ORG", count: 1 },
      ]),
    ).toBe(
      "Blocked: the outgoing text still contains 2 names, 1 organization from your document that should have been masked. Send is disabled; nothing will be sent.",
    );
  });

  it("maps every router reason code to copy", () => {
    expect(reasonLine("nano_unavailable")).toMatch(/Gemini Nano is not available/);
    expect(reasonLine("over_budget", { estimatedTokens: 7500 })).toBe(
      "The document and request are too long for the on-device model (about 7,500 tokens; the on-device budget is 6,000).",
    );
    expect(reasonLine("user_requested_cloud")).toBe("You asked for a deeper answer from the cloud.");
    expect(reasonLine("hard_question", { hardQuestion: ["comparison", "compute"] })).toBe(
      "Your request looks hard for the on-device model (a comparison, a calculation).",
    );
    expect(reasonLine("hard_question")).toBe("Your request looks hard for the on-device model.");
    expect(reasonLine("on_device_failed")).toMatch(/failed or returned an empty answer/);
  });

  it("formats the cloud status line per ARCHITECTURE 3.3 / 4.2", () => {
    expect(cloudStatusLine(1234)).toBe(
      "Sent 1,234 characters of redacted text to Firebase AI Logic (Gemini cloud). The placeholder map stayed here.",
    );
  });

  it("gives a calm stay-on-device message on Cancel", () => {
    expect(cancelLine("explain")).toMatch(/^Kept on this device\. Nothing was sent\./);
    expect(cancelLine("draft")).toMatch(/shorter instruction/);
  });
});
