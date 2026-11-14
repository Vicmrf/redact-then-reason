// Day 5 hotfix: cloud Send is refused unless the on-device entity pass completed for the document.
// The cloud call is an injected mock; firebase/* are mocked too. No network. All PII is synthetic.
import { describe, expect, it, vi } from "vitest";

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/app-check", () => ({
  initializeAppCheck: vi.fn(() => ({})),
  CustomProvider: class CustomProvider {},
  ReCaptchaEnterpriseProvider: class ReCaptchaEnterpriseProvider {},
}));
vi.mock("firebase/ai", () => {
  const passthrough = (x: unknown) => x;
  return {
    getAI: vi.fn(() => ({})),
    GoogleAIBackend: class GoogleAIBackend {},
    getGenerativeModel: vi.fn(() => {
      throw new Error("firebase/ai must not be used in this test");
    }),
    InferenceMode: { ONLY_ON_DEVICE: "only_on_device", ONLY_IN_CLOUD: "only_in_cloud" },
    InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
    Schema: { object: passthrough, array: passthrough, enumString: passthrough, string: () => ({}), integer: () => ({}) },
  };
});

import {
  EntityPassIncompleteError,
  MapLeakError,
  PreflightError,
  type EntityPassStatus,
  type PlaceholderMap,
} from "@rtr/core";
import { sendToCloudGuarded } from "../src/lib/cloudSend";
import { parseStoredDoc } from "../src/lib/sessionStore";
import {
  ENTITY_PASS_BLOCKED,
  INSTRUCTION_PASS_BLOCKED,
  entityPassBlockedLine,
  entityPassReasonLine,
  instructionPassBlockedLine,
} from "../src/lib/consentCopy";

const map: PlaceholderMap = {
  docId: "doc-test",
  entries: [{ placeholder: "[PERSON_1]", type: "PERSON", original: "Jane Testperson" }],
} as unknown as PlaceholderMap;

const CLEAN = "Explain this letter for [PERSON_1].";

describe("sendToCloudGuarded", () => {
  const blocked: (EntityPassStatus | undefined)[] = ["skipped_too_long", "unavailable", "failed", "pending", undefined];

  for (const entityPass of blocked) {
    it(`rejects and never calls generate when entityPass is ${String(entityPass)} (clean payload, forced)`, async () => {
      const generate = vi.fn(async (_payload: string) => "sent");
      await expect(sendToCloudGuarded({ payload: CLEAN, map, entityPass, instructionPass: "not_needed" }, generate)).rejects.toBeInstanceOf(
        EntityPassIncompleteError,
      );
      expect(generate).not.toHaveBeenCalled();
    });
  }

  it("calls generate exactly once with the exact payload when complete and clean", async () => {
    const generate = vi.fn(async (_payload: string) => "answer");
    await expect(sendToCloudGuarded({ payload: CLEAN, map, entityPass: "complete", instructionPass: "not_needed" }, generate)).resolves.toBe("answer");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(CLEAN);
  });

  it("still refuses pre-flight and map leaks when the entity pass is complete", async () => {
    const generate = vi.fn(async (_payload: string) => "sent");
    await expect(
      sendToCloudGuarded({ payload: "[PERSON_1] jane.testperson@example.test", map, entityPass: "complete", instructionPass: "not_needed" }, generate),
    ).rejects.toBeInstanceOf(PreflightError);
    await expect(
      sendToCloudGuarded({ payload: "Explain this for Jane Testperson.", map, entityPass: "complete", instructionPass: "not_needed" }, generate),
    ).rejects.toBeInstanceOf(MapLeakError);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("Codex 3: draft instruction entity pass gates Send", () => {
  const blocked: (EntityPassStatus | undefined)[] = ["skipped_too_long", "unavailable", "failed", "pending", undefined];
  for (const instructionPass of blocked) {
    it(`rejects (scope instruction) and never calls generate when instructionPass is ${String(instructionPass)}`, async () => {
      const generate = vi.fn(async (_payload: string) => "sent");
      const err = await sendToCloudGuarded({ payload: CLEAN, map, entityPass: "complete", instructionPass }, generate).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EntityPassIncompleteError);
      expect((err as EntityPassIncompleteError).scope).toBe("instruction");
      expect(generate).not.toHaveBeenCalled();
    });
  }

  it("sends when both passes are complete", async () => {
    const generate = vi.fn(async (_payload: string) => "ok");
    await expect(
      sendToCloudGuarded({ payload: CLEAN, map, entityPass: "complete", instructionPass: "complete" }, generate),
    ).resolves.toBe("ok");
    expect(generate).toHaveBeenCalledWith(CLEAN);
  });

  it("a case / line-break variant of a map original blocks Send (Codex 1)", async () => {
    const generate = vi.fn(async (_payload: string) => "sent");
    await expect(
      sendToCloudGuarded(
        { payload: "Explain this for JANE\nTESTPERSON.", map, entityPass: "complete", instructionPass: "not_needed" },
        generate,
      ),
    ).rejects.toBeInstanceOf(MapLeakError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("instruction block copy", () => {
    expect(instructionPassBlockedLine("not_needed")).toBe("");
    expect(instructionPassBlockedLine("complete")).toBe("");
    expect(instructionPassBlockedLine("failed")).toBe(`${INSTRUCTION_PASS_BLOCKED}\nThe on-device check failed.`);
    expect(instructionPassBlockedLine(undefined).startsWith(INSTRUCTION_PASS_BLOCKED)).toBe(true);
  });
});

describe("entity-pass block copy", () => {
  it("uses the exact block message plus a reason-specific second line", () => {
    expect(ENTITY_PASS_BLOCKED).toBe(
      "Names and addresses couldn't be checked on this device for this document, so it can't be sent to the cloud yet.",
    );
    expect(entityPassBlockedLine("skipped_too_long")).toBe(`${ENTITY_PASS_BLOCKED}\nThe document is too long for the on-device check.`);
    expect(entityPassBlockedLine("unavailable")).toBe(`${ENTITY_PASS_BLOCKED}\nThe on-device model is unavailable.`);
    expect(entityPassBlockedLine("failed")).toBe(`${ENTITY_PASS_BLOCKED}\nThe on-device check failed.`);
    expect(entityPassBlockedLine(undefined).startsWith(ENTITY_PASS_BLOCKED)).toBe(true);
    expect(entityPassBlockedLine("complete")).toBe("");
    expect(entityPassReasonLine("pending")).toMatch(/hasn't finished/);
  });
});

describe("stored session record", () => {
  it("keeps the status with the map; missing or unknown status reads as not complete", () => {
    expect(parseStoredDoc({ map, entityPass: "complete" })).toEqual({ map, entityPass: "complete" });
    expect(parseStoredDoc({ map, entityPass: "failed" })?.entityPass).toBe("failed");
    expect(parseStoredDoc({ map })?.entityPass).toBe("pending");
    expect(parseStoredDoc({ map, entityPass: "yes" })?.entityPass).toBe("pending");
    expect(parseStoredDoc(map)).toEqual({ map, entityPass: "pending" }); // legacy bare map
    expect(parseStoredDoc(null)).toBeNull();
    expect(parseStoredDoc({ foo: 1 })).toBeNull();
  });
});
