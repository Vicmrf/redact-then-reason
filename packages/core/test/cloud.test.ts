// Day 5: consent payload, pre-flight leak block, and the ONLY_IN_CLOUD path.
// firebase/* are mocked: no network and no model are used. All PII is synthetic.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
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

import { buildCloudPayload, summarizeMasked } from "../src/consent/payload";
import { PreflightError } from "../src/consent/preflight";
import { generateInCloud, generateInCloudStream } from "../src/firebase/generate";
import { CLOUD_MODEL_NAME } from "../src/firebase/models";
import { buildDraftPrompt } from "../src/prompts/draft";
import { buildExplainPrompt } from "../src/prompts/explain";
import { mask } from "../src/redaction/mask";
import { redact } from "../src/redaction/redact";
import { SUSPECT_TOKEN, unmask } from "../src/redaction/unmask";
import type { Detection, PlaceholderMap } from "../src/types";

const RAW =
  "Dear Jane Q. Example, your SSN 078-05-1120 is on file. Call (202) 555-0143 or write to billing@example.org about card 4111 1111 1111 1111.";

/** Synthetic doc with an LLM-style PERSON span plus regex identifiers. */
function synthetic(): { raw: string; masked: string; map: PlaceholderMap } {
  const raw = RAW;
  const base = redact(raw).map.entries.map<Detection>((e) => ({
    type: e.type,
    start: e.start,
    end: e.end,
    text: e.original,
    source: "regex",
  }));
  const nameStart = raw.indexOf("Jane Q. Example");
  const person: Detection = { type: "PERSON", start: nameStart, end: nameStart + 15, text: "Jane Q. Example", source: "llm" };
  const { masked, map } = mask(raw, [...base, person], { docId: "doc-test", createdAt: 1 });
  return { raw, masked, map };
}

const LEAKS: Array<[string, string]> = [
  ["EMAIL", "Contact [PERSON_1] at leaked@example.com"],
  ["SSN", "[PERSON_1] SSN 123-45-6789"],
  ["CREDIT_CARD", "Card 4242 4242 4242 4242"],
  ["PHONE", "Call (202) 555-0199"],
];

const STOP = [{ finishReason: "STOP" }];

/** Mirrors the SDK: inferenceSource on every chunk and on the aggregate; finishReason on the last. */
/** `null` means "not reported" (a default parameter would swallow `undefined`). */
function streamReturns(pieces: string[], source: string | null = "in_cloud", finishReason: string | null = "STOP"): void {
  const inferenceSource = source ?? undefined;
  const candidates = finishReason ? [{ finishReason }] : [{}];
  mocks.generateContentStream.mockResolvedValue({
    stream: (async function* () {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        yield { text: () => p, inferenceSource, candidates: i === pieces.length - 1 ? candidates : [{}] };
      }
    })(),
    response: Promise.resolve({ text: () => pieces.join(""), inferenceSource, candidates }),
  });
}

function contentReturns(text: string, source: string | null = "in_cloud"): void {
  mocks.generateContent.mockResolvedValue({
    response: { text: () => text, inferenceSource: source ?? undefined, candidates: STOP },
  });
}

/** An AIError-like throw from text(), as the SDK does for SAFETY / RECITATION / ... */
function blockedText(): string {
  throw new Error("Response error: Candidate was blocked");
}

beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app-id");
  mocks.generateContent.mockReset();
  mocks.generateContentStream.mockReset();
  mocks.getGenerativeModel.mockImplementation(() => ({
    generateContent: (...args: unknown[]) => mocks.generateContent(...args),
    generateContentStream: (...args: unknown[]) => mocks.generateContentStream(...args),
  }));
});

describe("buildCloudPayload", () => {
  it("builds the explain payload from the redacted text only", () => {
    const { masked, map } = synthetic();
    const p = buildCloudPayload(masked, { kind: "explain" });
    expect(p.text).toBe(buildExplainPrompt(masked));
    expect(p.text).toContain(masked);
    for (const t of ["[PERSON_1]", "[SSN_1]", "[PHONE_1]", "[EMAIL_1]", "[CREDIT_CARD_1]"]) expect(p.text).toContain(t);
    for (const e of map.entries) expect(p.text).not.toContain(e.original);
    expect(p.preflight).toEqual({ ok: true, hits: [] });
    expect(Object.isFrozen(p)).toBe(true);
  });

  it("builds the draft payload with the instruction and no originals", () => {
    const { masked, map } = synthetic();
    const p = buildCloudPayload(masked, { kind: "draft", instruction: "Ask for a payment plan" });
    expect(p.text).toBe(buildDraftPrompt(masked, "Ask for a payment plan"));
    expect(p.text).toContain("Ask for a payment plan");
    for (const e of map.entries) expect(p.text).not.toContain(e.original);
    expect(p.preflight.ok).toBe(true);
  });

  it("flags a leak that arrives through the instruction (pre-flight runs on the FINAL payload)", () => {
    const { masked } = synthetic();
    const p = buildCloudPayload(masked, { kind: "draft", instruction: "cc me at me@example.net" });
    expect(p.preflight.ok).toBe(false);
    expect(p.preflight.hits).toEqual([{ type: "EMAIL", count: 1 }]);
  });

  it("is byte-for-byte what generateInCloudStream sends", async () => {
    const { masked } = synthetic();
    const p = buildCloudPayload(masked, { kind: "explain" });
    streamReturns(["ok"]);
    await generateInCloudStream(p.text, () => {});
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(mocks.generateContentStream.mock.calls[0]![0]).toBe(p.text);
  });
});

describe("summarizeMasked", () => {
  it("counts distinct masked values per type in a stable order", () => {
    const { map } = synthetic();
    expect(summarizeMasked(map)).toEqual([
      { type: "PERSON", count: 1 },
      { type: "EMAIL", count: 1 },
      { type: "PHONE", count: 1 },
      { type: "SSN", count: 1 },
      { type: "CREDIT_CARD", count: 1 },
    ]);
    const m = redact("a@example.com b@example.com A@EXAMPLE.COM").map;
    expect(summarizeMasked(m)).toEqual([{ type: "EMAIL", count: 2 }]);
    expect(summarizeMasked({ docId: "x", createdAt: 0, entries: [] })).toEqual([]);
    expect(JSON.stringify(summarizeMasked(synthetic().map))).not.toContain("example");
  });
});

describe("pre-flight leak block in generateInCloud*", () => {
  it.each(LEAKS)("refuses a payload with a residual %s without calling the model", async (type, payload) => {
    const p = buildCloudPayload(payload, { kind: "explain" });
    expect(p.preflight.ok).toBe(false);
    expect(p.preflight.hits.map((h) => h.type)).toContain(type);
    await expect(generateInCloud(p.text)).rejects.toBeInstanceOf(PreflightError);
    await expect(generateInCloudStream(p.text, () => {})).rejects.toBeInstanceOf(PreflightError);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
  });

  it("lets a placeholders-only payload through", async () => {
    const p = buildCloudPayload("[PERSON_1] emailed [EMAIL_1] about [SSN_1], [CREDIT_CARD_1], [PHONE_1].", {
      kind: "explain",
    });
    expect(p.preflight.ok).toBe(true);
    contentReturns("Fine.");
    await expect(generateInCloud(p.text)).resolves.toEqual({
      text: "Fine.",
      inferenceSource: "in_cloud",
      complete: true,
      finishReason: "STOP",
    });
    expect(mocks.generateContent).toHaveBeenCalledWith(p.text);
  });
});

describe("generateInCloud*", () => {
  it("uses an ONLY_IN_CLOUD model pinned to gemini-3.5-flash-lite", async () => {
    // Fresh module graph so the memoized cloud model is constructed inside this test.
    vi.resetModules();
    mocks.getGenerativeModel.mockClear();
    const fresh = await import("../src/firebase/generate");
    streamReturns(["a", "b"]);
    const chunks: string[] = [];
    const out = await fresh.generateInCloudStream("[PERSON_1] wrote.", (c) => chunks.push(c));
    expect(out).toEqual({ text: "ab", inferenceSource: "in_cloud", complete: true, finishReason: "STOP" });
    expect(chunks).toEqual(["a", "b"]);
    expect(CLOUD_MODEL_NAME).toBe("gemini-3.5-flash-lite");
    const cloudCalls = mocks.getGenerativeModel.mock.calls.filter(
      (c) => (c[1] as { mode: string }).mode === "only_in_cloud",
    );
    expect(cloudCalls).toHaveLength(1);
    const params = cloudCalls[0]![1] as { mode: string; inCloudParams: { model: string }; onDeviceParams?: unknown };
    expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");
    expect(params.onDeviceParams).toBeUndefined();
    for (const c of mocks.getGenerativeModel.mock.calls) {
      expect(["only_on_device", "only_in_cloud"]).toContain((c[1] as { mode: string }).mode);
    }
  });

  it("refuses a non-IN_CLOUD inferenceSource", async () => {
    streamReturns(["local"], "on_device");
    await expect(generateInCloudStream("[PERSON_1] wrote.", () => {})).rejects.toThrow(
      /Refusing unexpected inference source: on_device/,
    );
    contentReturns("local", "on_device");
    await expect(generateInCloud("[PERSON_1] wrote.")).rejects.toThrow(/Refusing unexpected inference source/);
  });

  // Codex 14: the pinned SDK always sets inferenceSource (callCloudOrDevice), so a missing one is
  // refused instead of being reported as an assumed source.
  it("refuses a missing inferenceSource instead of assuming in_cloud", async () => {
    contentReturns("x", null);
    await expect(generateInCloud("[PERSON_1]")).rejects.toThrow(/did not report an inference source/);
    streamReturns(["x"], null);
    const chunks: string[] = [];
    await expect(generateInCloudStream("[PERSON_1]", (c) => chunks.push(c))).rejects.toThrow(
      /did not report an inference source/,
    );
    expect(chunks).toEqual([]); // nothing reached the UI
  });

  it("checks each chunk's source before its text reaches onChunk", async () => {
    streamReturns(["local text"], "on_device");
    const chunks: string[] = [];
    await expect(generateInCloudStream("[PERSON_1]", (c) => chunks.push(c))).rejects.toThrow(/on_device/);
    expect(chunks).toEqual([]);
  });

  // Codex 15: only finishReason STOP is a complete answer.
  it.each(["MAX_TOKENS", "OTHER"])("a stream ending with %s resolves as incomplete with the partial text", async (reason) => {
    streamReturns(["Partial ", "answer"], "in_cloud", reason);
    const out = await generateInCloudStream("[PERSON_1]", () => {});
    expect(out).toEqual({ text: "Partial answer", inferenceSource: "in_cloud", complete: false, finishReason: reason });
  });

  it("a stream with no finishReason at all is not reported as complete", async () => {
    streamReturns(["cut off"], "in_cloud", null);
    const out = await generateInCloudStream("[PERSON_1]", () => {});
    expect(out.complete).toBe(false);
    expect(out.finishReason).toBe("NOT_REPORTED");
  });

  it.each(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "SPII", "BLOCKLIST"])(
    "a %s-blocked chunk stops the stream: partial text kept, marked incomplete",
    async (reason) => {
      mocks.generateContentStream.mockResolvedValue({
        stream: (async function* () {
          yield { text: () => "Safe part. ", inferenceSource: "in_cloud", candidates: [{}] };
          yield { text: blockedText, inferenceSource: "in_cloud", candidates: [{ finishReason: reason }] };
        })(),
        response: Promise.resolve({ text: blockedText, inferenceSource: "in_cloud", candidates: [{ finishReason: reason }] }),
      });
      const chunks: string[] = [];
      const out = await generateInCloudStream("[PERSON_1]", (c) => chunks.push(c));
      expect(out).toEqual({ text: "Safe part. ", inferenceSource: "in_cloud", complete: false, finishReason: reason });
      expect(chunks).toEqual(["Safe part. "]);
      mocks.generateContent.mockResolvedValue({
        response: { text: blockedText, inferenceSource: "in_cloud", candidates: [{ finishReason: reason }] },
      });
      await expect(generateInCloud("[PERSON_1]")).resolves.toMatchObject({ complete: false, finishReason: reason });
    },
  );

  it("a blocked prompt (no candidates) still rejects", async () => {
    mocks.generateContent.mockResolvedValue({ response: { text: blockedText, inferenceSource: "in_cloud" } });
    await expect(generateInCloud("[PERSON_1]")).rejects.toThrow(/blocked/);
  });

  it("cloud output is unmasked locally and invented identifiers are hidden", async () => {
    const { masked, map } = synthetic();
    const p = buildCloudPayload(masked, { kind: "explain" });
    streamReturns(["[PERSON_1] should email [EMAIL_1]. ", "Or try invented@example.com."]);
    const { text } = await generateInCloudStream(p.text, () => {});
    const out = unmask(text, map);
    expect(out.text).toBe(`Jane Q. Example should email billing@example.org. Or try ${SUSPECT_TOKEN}.`);
    expect(out.suspects).toBe(1);
  });
});
