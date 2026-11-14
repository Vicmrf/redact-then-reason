// Day 3: on-device LLM extraction, span verification, regex+LLM merge.
// firebase/* are mocked: no network and no model are used. All PII is synthetic.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
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

import { extractEntitiesOnDevice, verifyLlmSpans, buildPiiExtractPrompt } from "../src/redaction/llmExtract";
import { redact, redactWithLlm } from "../src/redaction/redact";

function modelReturns(text: string, inferenceSource: string | undefined = "on_device"): void {
  mocks.generateContent.mockResolvedValue({ response: { text: () => text, inferenceSource } });
}

beforeEach(() => {
  vi.stubGlobal("self", globalThis); // Node test env has no `self`.
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app-id");
  mocks.generateContent.mockReset();
  mocks.getGenerativeModel.mockImplementation(() => ({ generateContent: mocks.generateContent }));
});

describe("verifyLlmSpans", () => {
  const src = "Dear Jane Testperson, Acme Test Clinic confirms Jane Testperson's visit.";

  it("uses consistent offsets", () => {
    const start = src.indexOf("Acme Test Clinic");
    const out = verifyLlmSpans(src, [{ type: "ORG", text: "Acme Test Clinic", start, end: start + 16 }]);
    expect(out).toEqual([{ type: "ORG", start, end: start + 16, text: "Acme Test Clinic", source: "llm" }]);
  });

  it("falls back to indexOf with a moving cursor for repeated names and bad offsets", () => {
    const out = verifyLlmSpans(src, [
      { type: "PERSON", text: "Jane Testperson", start: 0, end: 3 }, // inconsistent offsets
      { type: "PERSON", text: "Jane Testperson" },
    ]);
    const first = src.indexOf("Jane Testperson");
    const second = src.indexOf("Jane Testperson", first + 1);
    expect(out.map((d) => d.start)).toEqual([first, second]);
    for (const d of out) expect(src.slice(d.start, d.end)).toBe(d.text);
  });

  it("drops hallucinated, empty, whitespace and unknown-type entities", () => {
    const out = verifyLlmSpans(src, [
      { type: "PERSON", text: "John Notinsource" },
      { type: "PERSON", text: "" },
      { type: "ORG", text: "   " },
      { type: "EMAIL", text: "Jane Testperson" },
      { type: "person", text: "Jane Testperson" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("PERSON");
  });
});

describe("extractEntitiesOnDevice", () => {
  const raw = "Patient Jane Testperson, MRN TEST-0001, Acme Test Clinic.";

  it("valid JSON -> verified detections, ONLY_ON_DEVICE model, raw text in prompt", async () => {
    modelReturns(
      JSON.stringify({
        entities: [
          { type: "PERSON", text: "Jane Testperson" },
          { type: "ORG", text: "Acme Test Clinic" },
          { type: "PERSON", text: "Not In Doc" },
        ],
      }),
    );
    const res = await extractEntitiesOnDevice(raw);
    expect(res.warnings).toEqual([]);
    expect(res.detections.map((d) => [d.type, d.text, d.source])).toEqual([
      ["PERSON", "Jane Testperson", "llm"],
      ["ORG", "Acme Test Clinic", "llm"],
    ]);
    const cfg = mocks.getGenerativeModel.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(cfg.mode).toBe("only_on_device");
    expect(cfg.inCloudParams).toBeUndefined();
    expect((cfg.onDeviceParams as { promptOptions?: unknown }).promptOptions).toBeDefined();
    expect(mocks.generateContent).toHaveBeenCalledWith(buildPiiExtractPrompt(raw));
  });

  it("bad JSON -> [] plus a non-PII warning", async () => {
    modelReturns("{not json Jane Testperson");
    const res = await extractEntitiesOnDevice(raw);
    expect(res.detections).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).not.toContain("Jane");
  });

  it("JSON without an entities array -> []", async () => {
    modelReturns(JSON.stringify({ people: ["Jane Testperson"] }));
    const res = await extractEntitiesOnDevice(raw);
    expect(res.detections).toEqual([]);
    expect(res.warnings).toHaveLength(1);
  });

  it("refuses a non-on-device inference source", async () => {
    modelReturns(JSON.stringify({ entities: [] }), "in_cloud");
    await expect(extractEntitiesOnDevice(raw)).rejects.toThrow(/Refusing unexpected inference source/);
  });
});

describe("prompt builder", () => {
  it("asks for exact substrings of the listed types", () => {
    const p = buildPiiExtractPrompt("SYNTHETIC DOC");
    for (const t of ["PERSON", "ORG", "ADDRESS", "MRN", "ACCOUNT", "OTHER"]) expect(p).toContain(t);
    expect(p).toMatch(/EXACT substring/);
    expect(p).toContain("SYNTHETIC DOC");
  });
});

describe("merge regex + LLM", () => {
  it("regex EMAIL beats an overlapping LLM PERSON; repeated names reuse [PERSON_1]", () => {
    const raw = "From jane.testperson@example.test - Jane Testperson. Thanks, Jane Testperson.";
    const llm = verifyLlmSpans(raw, [
      { type: "PERSON", text: "jane.testperson" }, // overlaps the email
      { type: "PERSON", text: "Jane Testperson" },
      { type: "PERSON", text: "Jane Testperson" },
    ]);
    const res = redactWithLlm(raw, llm, { docId: "test-doc", createdAt: 0 });
    expect(res.masked).toBe("From [EMAIL_1] - [PERSON_1]. Thanks, [PERSON_1].");
    expect(res.counts).toEqual(
      expect.arrayContaining([
        { type: "EMAIL", count: 1 },
        { type: "PERSON", count: 2 },
      ]),
    );
    expect(res.map.entries.filter((e) => e.type === "PERSON")).toHaveLength(1);
  });

  it("redact() without LLM detections is unchanged", () => {
    const raw = "Mail jane.testperson@example.test today.";
    expect(redact(raw, { docId: "d", createdAt: 0 })).toEqual(redactWithLlm(raw, [], { docId: "d", createdAt: 0 }));
  });
});
