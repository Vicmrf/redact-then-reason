// Day 4: draft-reply prompt, budget guard, and the ONLY_ON_DEVICE draft path.
// firebase/* are mocked: no network and no model are used. All PII is synthetic.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContentStream: vi.fn(),
  getGenerativeModel: vi.fn(),
}));

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
    getGenerativeModel: mocks.getGenerativeModel,
    InferenceMode: { ONLY_ON_DEVICE: "only_on_device", ONLY_IN_CLOUD: "only_in_cloud" },
    InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
    Schema: {
      object: passthrough,
      array: passthrough,
      enumString: passthrough,
      string: () => ({}),
      integer: () => ({}),
    },
  };
});

import { draftReplyOnDevice } from "../src/firebase/draft";
import {
  buildDraftPrompt,
  draftFitsOnDevice,
  DRAFT_INSTRUCTION_MAX_CHARS,
  normalizeDraftInstruction,
  TOO_LONG_FOR_DRAFT,
} from "../src/prompts/draft";
import { PLACEHOLDER_RULE } from "../src/prompts/explain";
import { redact } from "../src/redaction/redact";

const RAW =
  "Dear Jane Q. Example, please call (202) 555-0143 or write to billing@example.org about card 4111 1111 1111 1111.";

function streamReturns(pieces: string[], inferenceSource: string | undefined = "on_device"): void {
  mocks.generateContentStream.mockResolvedValue({
    stream: (async function* () {
      for (const p of pieces) yield { text: () => p };
    })(),
    response: Promise.resolve({ text: () => pieces.join(""), inferenceSource }),
  });
}

beforeEach(() => {
  vi.stubGlobal("self", globalThis); // Node test env has no `self`.
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app-id");
  mocks.generateContentStream.mockReset();
  mocks.getGenerativeModel.mockImplementation(() => ({
    generateContentStream: (...args: unknown[]) => mocks.generateContentStream(...args),
  }));
});

describe("draft prompt", () => {
  it("includes the placeholder rule, the redacted text, and asks for a short polite reply", () => {
    const { masked } = redact(RAW);
    const p = buildDraftPrompt(masked);
    expect(p).toContain(PLACEHOLDER_RULE);
    expect(p).toContain("Placeholders look like `[TYPE_N]`. Copy them verbatim. Do not invent values for them.");
    expect(p).toMatch(/short, polite reply/);
    expect(p).toContain(masked);
    expect(p).toContain("[EMAIL_1]");
    expect(p).not.toContain("instruction for this reply");
  });

  it("does not contain the raw identifiers when given redacted text", () => {
    const p = buildDraftPrompt(redact(RAW).masked);
    expect(p).not.toContain("billing@example.org");
    expect(p).not.toContain("555-0143");
    expect(p).not.toContain("4111 1111 1111 1111");
  });

  it("trims, flattens and caps the optional instruction", () => {
    expect(normalizeDraftInstruction(undefined)).toBe("");
    expect(normalizeDraftInstruction("   \n  ")).toBe("");
    expect(normalizeDraftInstruction("  Ask for\n\na payment plan  ")).toBe("Ask for a payment plan");
    const long = normalizeDraftInstruction("a".repeat(1000));
    expect(long.length).toBe(DRAFT_INSTRUCTION_MAX_CHARS);
    const p = buildDraftPrompt("[PERSON_1] wrote.", "  Be brief\nand friendly  ");
    expect(p).toContain("The reader's instruction for this reply (tone or goal): Be brief and friendly");
    expect(buildDraftPrompt("x", "b".repeat(1000))).not.toContain("b".repeat(DRAFT_INSTRUCTION_MAX_CHARS + 1));
  });
});

describe("draft budget guard", () => {
  it("rejects prompts over the on-device budget without calling a model", async () => {
    expect(draftFitsOnDevice(buildDraftPrompt("short"))).toBe(true);
    expect(draftFitsOnDevice(buildDraftPrompt("y".repeat(24_000)))).toBe(false);
    const onChunk = vi.fn();
    const out = await draftReplyOnDevice("y".repeat(24_000), undefined, onChunk);
    expect(out).toEqual({ kind: "too_long", message: TOO_LONG_FOR_DRAFT });
    expect(TOO_LONG_FOR_DRAFT).toBe("Too long for on-device draft.");
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
    expect(onChunk).not.toHaveBeenCalled();
  });
});

describe("draftReplyOnDevice", () => {
  it("streams via an ONLY_ON_DEVICE model with the redacted prompt", async () => {
    const { masked } = redact(RAW);
    streamReturns(["Dear ", "[EMAIL_1] team, ", "thank you."]);
    const chunks: string[] = [];
    const out = await draftReplyOnDevice(masked, "Be brief", (c) => chunks.push(c));
    expect(out).toEqual({ kind: "ok", text: "Dear [EMAIL_1] team, thank you.", inferenceSource: "on_device" });
    expect(chunks).toEqual(["Dear ", "[EMAIL_1] team, ", "thank you."]);

    const prompt = mocks.generateContentStream.mock.calls[0]![0] as string;
    expect(prompt).toContain(masked);
    expect(prompt).not.toContain("billing@example.org");

    expect(mocks.getGenerativeModel).toHaveBeenCalled();
    for (const call of mocks.getGenerativeModel.mock.calls) {
      const params = call[1] as { mode: string; inCloudParams?: unknown };
      expect(params.mode).toBe("only_on_device");
      expect(params.inCloudParams).toBeUndefined();
    }
  });

  it("refuses a non-ON_DEVICE inferenceSource", async () => {
    streamReturns(["cloud text"], "in_cloud");
    await expect(draftReplyOnDevice("[PERSON_1] wrote.", undefined, () => {})).rejects.toThrow(
      /Refusing unexpected inference source: in_cloud/,
    );
  });

  it("propagates on-device failures (no cloud fallback)", async () => {
    mocks.generateContentStream.mockRejectedValue(new Error("on-device model unavailable"));
    await expect(draftReplyOnDevice("[PERSON_1] wrote.", undefined, () => {})).rejects.toThrow(
      /unavailable/,
    );
    for (const call of mocks.getGenerativeModel.mock.calls) {
      expect((call[1] as { mode: string }).mode).toBe("only_on_device");
    }
  });
});
