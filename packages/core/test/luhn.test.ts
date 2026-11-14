import { describe, expect, it } from "vitest";
import { luhnOk } from "../src/redaction/luhn";

describe("luhnOk", () => {
  it.each(["4111111111111111", "5555555555554444", "378282246310005", "4242424242424242"])(
    "accepts public test number %s",
    (n) => expect(luhnOk(n)).toBe(true),
  );

  it("rejects a checksum failure", () => {
    expect(luhnOk("4111111111111112")).toBe(false);
    expect(luhnOk("1234567812345678")).toBe(false);
  });

  it("rejects fewer than 13 digits even if the checksum passes", () => {
    expect(luhnOk("0")).toBe(false);
    expect(luhnOk("79927398713")).toBe(false); // classic valid Luhn, 11 digits
  });

  it("rejects non-digit characters", () => {
    expect(luhnOk("4111 1111 1111 1111")).toBe(false);
    expect(luhnOk("4111-1111-1111-1111")).toBe(false);
  });
});
