import { describe, expect, it } from "vitest";
import { assertPreflight, preflightCheck, PreflightError, PREFLIGHT_BLOCKING_TYPES } from "../src/consent/preflight";
import { redact } from "../src/redaction/redact";

describe("preflight", () => {
  it("passes a fully redacted payload", () => {
    const { masked } = redact("Email a@example.com, SSN 078-05-1120, card 4111 1111 1111 1111, phone (202) 555-0143");
    const res = preflightCheck(masked);
    expect(res).toEqual({ ok: true, hits: [] });
    expect(() => assertPreflight(masked)).not.toThrow();
  });

  it.each([
    ["EMAIL", "Please reply to [EMAIL_1] and leaked@example.com"],
    ["SSN", "Applicant [PERSON_1], SSN 123-45-6789"],
    ["CREDIT_CARD", "Charge 4242 4242 4242 4242 today"],
    ["PHONE", "Call [PERSON_1] at (202) 555-0143"],
  ])("fails when the payload still contains %s", (type, payload) => {
    const res = preflightCheck(payload);
    expect(res.ok).toBe(false);
    expect(res.hits).toEqual([{ type, count: 1 }]);
    expect(() => assertPreflight(payload)).toThrow(PreflightError);
  });

  it("never includes the raw value in results or error messages", () => {
    const secrets = ["leaked@example.com", "123-45-6789", "4242 4242 4242 4242", "(202) 555-0143"];
    const payload = `x ${secrets.join(" y ")} z`;
    const res = preflightCheck(payload);
    let err: unknown;
    try {
      assertPreflight(payload);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreflightError);
    const serialized = JSON.stringify(res) + String((err as Error).message) + JSON.stringify((err as PreflightError).hits);
    for (const s of secrets) expect(serialized).not.toContain(s);
    expect((err as Error).message).toMatch(/EMAIL/);
  });

  it("blocks phones (stricter than ARCHITECTURE 5, by design)", () => {
    expect(PREFLIGHT_BLOCKING_TYPES).toEqual(new Set(["EMAIL", "SSN", "CREDIT_CARD", "PHONE"]));
    const res = preflightCheck("Call +44 20 7946 0958");
    expect(res.ok).toBe(false);
    expect(res.hits).toEqual([{ type: "PHONE", count: 1 }]);
    expect(() => assertPreflight("Call +44 20 7946 0958")).toThrow(/1 PHONE/);
  });

  it("does not block on placeholders or invalid SSN ranges", () => {
    expect(preflightCheck("[EMAIL_1] [SSN_1] [CREDIT_CARD_1] [PHONE_1] 900-12-3456").ok).toBe(true);
  });
});
