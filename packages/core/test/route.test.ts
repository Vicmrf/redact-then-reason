// Day 5: router (ARCHITECTURE 3.6). Pure; no Firebase involved.
import { describe, expect, it } from "vitest";
import { classifyHardQuestion, decideRoute, type RouteInput } from "../src/router/route";
import { ON_DEVICE_INPUT_BUDGET } from "../src/prompts/explain";

const easy: RouteInput = { redactedChars: 1200, rawChars: 1180, question: "", overheadChars: 400, nanoAvailable: true };

describe("decideRoute", () => {
  it("keeps a short, easy request on-device", () => {
    expect(decideRoute(easy)).toEqual({ route: "on_device", estimatedTokens: Math.ceil((1180 + 400) / 4) });
    expect(decideRoute({ ...easy, question: "What do I need to do by Friday?" }).route).toBe("on_device");
  });

  it("offers the cloud when the budget is exceeded", () => {
    const d = decideRoute({ ...easy, rawChars: 30_000, redactedChars: 29_000 });
    expect(d).toMatchObject({ route: "offer_cloud", reasons: ["over_budget"] });
  });

  it("uses the redacted length when the on-device path would not use raw text", () => {
    const d = decideRoute({ redactedChars: 25_000, overheadChars: 0, nanoAvailable: true });
    expect(d).toMatchObject({ route: "offer_cloud", reasons: ["over_budget"] });
  });

  it("is on-device at exactly the budget and offers cloud one character above it", () => {
    const atBudget = ON_DEVICE_INPUT_BUDGET * 4; // 24,000 chars = 6000 tokens
    const base = { redactedChars: 0, nanoAvailable: true, question: "abcd", overheadChars: 96 };
    expect(decideRoute({ ...base, rawChars: atBudget - 100 })).toEqual({ route: "on_device", estimatedTokens: 6000 });
    const over = decideRoute({ ...base, rawChars: atBudget - 99 });
    expect(over).toMatchObject({ route: "offer_cloud", reasons: ["over_budget"], estimatedTokens: 6001 });
  });

  it.each([
    ["comparison", "Compare the two quotes and tell me which is cheaper"],
    ["comparison", "What is the difference between plan A versus plan B?"],
    ["multi_hop", "Cross-reference the dates with the payment schedule"],
    ["enumerate_all", "List every deadline in this letter"],
    ["enumerate_all", "Find all mentions of my insurer"],
    ["inconsistencies", "Find all inconsistencies in the amounts"],
    ["inconsistencies", "Does anything contradict the earlier notice?"],
    ["compute", "Compute the total I owe after the refund"],
    ["compute", "Calculate the average monthly charge"],
  ])("offers the cloud for a hard question (%s): %s", (family, question) => {
    const d = decideRoute({ ...easy, question });
    expect(d.route).toBe("offer_cloud");
    if (d.route !== "offer_cloud") return;
    expect(d.reasons).toContain("hard_question");
    expect(d.hardQuestion).toContain(family);
  });

  it("does not flag ordinary instructions", () => {
    for (const q of ["Ask for a payment plan, keep it friendly", "Be brief", "Totally fine, say thanks", ""]) {
      expect(classifyHardQuestion(q)).toEqual([]);
    }
    expect(classifyHardQuestion(undefined)).toEqual([]);
  });

  it("offers the cloud when the user asked for a deeper answer", () => {
    expect(decideRoute({ ...easy, userRequestedCloud: true })).toMatchObject({
      route: "offer_cloud",
      reasons: ["user_requested_cloud"],
    });
  });

  it("offers the cloud after an on-device failure (no auto-fallback)", () => {
    expect(decideRoute({ ...easy, onDeviceFailed: true })).toMatchObject({
      route: "offer_cloud",
      reasons: ["on_device_failed"],
    });
  });

  it("offers the cloud (does not silently call it) when Nano is unavailable", () => {
    expect(decideRoute({ ...easy, nanoAvailable: false })).toMatchObject({
      route: "offer_cloud",
      reasons: ["nano_unavailable"],
    });
  });

  it("collects every applicable reason", () => {
    const d = decideRoute({
      redactedChars: 40_000,
      question: "compare these",
      nanoAvailable: false,
      userRequestedCloud: true,
      onDeviceFailed: true,
    });
    expect(d).toMatchObject({
      route: "offer_cloud",
      reasons: ["nano_unavailable", "over_budget", "user_requested_cloud", "hard_question", "on_device_failed"],
    });
  });

  it("never returns an automatic cloud route", () => {
    const flags = [true, false];
    for (const nanoAvailable of flags)
      for (const userRequestedCloud of flags)
        for (const onDeviceFailed of flags)
          for (const redactedChars of [10, 24_000, 100_000])
            for (const question of ["", "list every fee"]) {
              const d = decideRoute({ redactedChars, question, nanoAvailable, userRequestedCloud, onDeviceFailed });
              expect(["on_device", "offer_cloud"]).toContain(d.route);
            }
  });
});
