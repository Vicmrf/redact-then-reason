// Day 5 bug sweep regression tests (Codex findings 1, 2, 3-core, 5, 7, 11, 14-on-device and
// own finding C1). firebase/* are mocked: no network, no model. All PII is synthetic.
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
    Schema: { object: passthrough, array: passthrough, enumString: passthrough, string: () => ({}), integer: () => ({}) },
  };
});

import { checkCloudSend, findMapLeaks, MapLeakError, normalizeForLeakCheck } from "../src/consent/leaks";
import { buildCloudPayload } from "../src/consent/payload";
import { preflightCheck } from "../src/consent/preflight";
import { generateOnDevice, generateOnDeviceStream } from "../src/firebase/generate";
import { extractEntitiesOnDevice, parseLlmEntities } from "../src/redaction/llmExtract";
import { extendMask, literalTokens, mask } from "../src/redaction/mask";
import { redact, redactWithMap } from "../src/redaction/redact";
import { detectCreditCards, detectDeterministic, detectPhones, detectSSNs } from "../src/redaction/regex";
import { unmask } from "../src/redaction/unmask";
import { classifyHardQuestion, decideRoute } from "../src/router/route";
import type { Detection, EntityType, PlaceholderMap } from "../src/types";

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

function mapOf(entries: Array<[EntityType, string]>): PlaceholderMap {
  return {
    docId: "d",
    createdAt: 0,
    entries: entries.map(([type, original], i) => ({ token: `[${type}_${i + 1}]`, type, original, start: 0, end: original.length })),
  };
}

const spans = (ds: Detection[]) => ds.map((d) => [d.type, d.text]);

// --------------------------------------------------------------------------------- Codex 1
describe("Codex 1: map-leak check is case / whitespace / Unicode insensitive", () => {
  const map = mapOf([["PERSON", "Jane Doe"]]);

  it.each([
    ["upper case", "Reply to JANE DOE today."],
    ["newline", "Reply to Jane\nDoe today."],
    ["double space", "Reply to Jane  Doe today."],
    ["NBSP", "Reply to Jane Doe today."],
    ["full-width (NFKC)", "Reply to Ｊane Ｄoe today."],
  ])("blocks the %s variant", (_label, payload) => {
    expect(findMapLeaks(payload, map)).toEqual([{ type: "PERSON", count: 1 }]);
    expect(checkCloudSend(payload, map, "complete").reasons).toContain("map_leak");
  });

  it("matches composed vs decomposed accents both ways", () => {
    expect(findMapLeaks("Ask José.", mapOf([["PERSON", "José"]]))).toHaveLength(1);
    expect(findMapLeaks("Ask José.", mapOf([["PERSON", "José"]]))).toHaveLength(1);
  });

  it("a multi-line original is caught in a single-line (normalized) instruction", () => {
    const m = mapOf([["ADDRESS", "12 Testing Lane\nSpringfield"]]);
    expect(findMapLeaks("Ship to 12 Testing Lane Springfield.", m)).toHaveLength(1);
  });

  it("keeps word boundaries (policy: 'Ann' does not block 'Annual') and skips 1-char originals", () => {
    const m = mapOf([["PERSON", "Ann"], ["OTHER", " J "]]);
    expect(findMapLeaks("The ANNUAL report from J.", m)).toEqual([]);
    expect(findMapLeaks("Ask ANN.", m)).toEqual([{ type: "PERSON", count: 1 }]);
  });

  it("normalizes only comparison copies: the payload string is untouched", () => {
    const payload = "Reply to JANE\nDOE.";
    const before = payload;
    expect(() => {
      const hits = findMapLeaks(payload, map);
      if (hits.length) throw new MapLeakError(hits);
    }).toThrow(/ignoring case, spacing and Unicode form/);
    expect(payload).toBe(before);
    expect(normalizeForLeakCheck("  A\n\tB  ")).toBe("a b");
  });
});

// --------------------------------------------------------------------------------- Codex 2
describe("Codex 2: SSN / phone / PAN detector coverage", () => {
  it("detects a space-separated SSN with the dashed-form validity rules", () => {
    const t = "SSN: 078 05 1120 on file.";
    expect(spans(detectSSNs(t))).toEqual([["SSN", "078 05 1120"]]);
    expect(detectSSNs("Ref 000 12 3456, 666 12 3456, 900 12 3456, 123 00 4567, 123 45 0000")).toEqual([]);
    expect(redact(t).masked).toBe("SSN: [SSN_1] on file.");
    expect(preflightCheck("SSN: 078 05 1120").ok).toBe(false);
  });

  it("does not take a spaced SSN out of a longer digit sequence", () => {
    expect(detectSSNs("Order 11 078 05 1120 22")).toEqual([]);
    expect(detectSSNs("Code 9 078 05 1120")).toEqual([]);
  });

  it("detects 8-15 digit international numbers with '+' and keeps NANP at 10+", () => {
    expect(spans(detectPhones("Call +352 621 123 now"))).toEqual([["PHONE", "+352 621 123"]]); // 9 digits
    expect(spans(detectPhones("Call +65 6123 4567"))).toEqual([["PHONE", "+65 6123 4567"]]);
    expect(spans(detectPhones("Call +49 30 1234 5678"))).toEqual([["PHONE", "+49 30 1234 5678"]]);
    expect(detectPhones("Call +1 234 567")).toEqual([]); // 7 digits
    expect(detectPhones("Call 555 0143 22")).toEqual([]); // 9 digits, no '+': not a phone
    expect(spans(detectPhones("Call (202) 555-0143"))).toEqual([["PHONE", "(202) 555-0143"]]);
  });

  it("detects a PAN split across lines / tabs / several spaces, with correct offsets", () => {
    for (const t of [
      "Card:\n4111 1111\n1111 1111\nthanks",
      "Card: 4111\t1111\t1111\t1111",
      "Card: 4111   1111   1111   1111",
      "Card: 4111 1111 \r\n 1111 1111",
    ]) {
      const d = detectCreditCards(t);
      expect(d).toHaveLength(1);
      expect(d[0]!.text.replace(/\D/g, "")).toBe("4111111111111111");
      expect(t.slice(d[0]!.start, d[0]!.end)).toBe(d[0]!.text);
      expect(preflightCheck(t).ok).toBe(false);
      expect(redact(t).masked).toContain("[CREDIT_CARD_1]");
      expect(redact(t).masked).not.toMatch(/4111|1111/);
    }
  });

  it("false-positive guards: dates, order ids, zip+4, currency, short numbers", () => {
    const t =
      "Date 2024-01-15, due 01/15/2024. Order #A-123456789. Zip 94105-1234. Total $1,234.56 or 1234.56 USD. Room 12 34 56. Year 2024 2025.";
    expect(detectDeterministic(t)).toEqual([]);
    expect(preflightCheck(t).ok).toBe(true);
  });

  it("C1: a PAN glued to a letter or 'word-' prefix is still detected", () => {
    for (const t of ["Card-4111-1111-1111-1111", "Visa4111111111111111", "ref x4111 1111 1111 1111"]) {
      expect(detectCreditCards(t)).toHaveLength(1);
      expect(preflightCheck(t).ok).toBe(false);
    }
    // ...but never starts or ends inside one unseparated digit run (20 digits: no whole-group window).
    expect(detectCreditCards("94111111111111111119")).toEqual([]);
    expect(detectCreditCards("41111111111111111_")).toEqual([]);
  });
});

// --------------------------------------------------------------------------------- Codex 5
describe("Codex 5: schema-invalid entity entries fail the entity pass", () => {
  it.each([
    ['{"entities":[{}]}'],
    ['{"entities":[{"type":"PERSON"}]}'],
    ['{"entities":[{"text":"Jane"}]}'],
    ['{"entities":[{"type":"NICKNAME","text":"Jane"}]}'],
    ['{"entities":[{"type":"PERSON","text":7}]}'],
    ['{"entities":["Jane"]}'],
    ['{"entities":[null]}'],
  ])("%s -> ok:false", (json) => {
    expect(parseLlmEntities(json).ok).toBe(false);
  });

  it("valid entries are still returned when another entry is invalid (still masked, pass failed)", () => {
    const r = parseLlmEntities('{"entities":[{"type":"PERSON","text":"Jane Doe"},{}]}');
    expect(r.ok).toBe(false);
    expect(r.entities).toEqual([{ type: "PERSON", text: "Jane Doe" }]);
  });

  it("an empty list and lower-case types are valid", () => {
    expect(parseLlmEntities('{"entities":[]}')).toEqual({ entities: [], ok: true });
    expect(parseLlmEntities('{"entities":[{"type":"person","text":"Jane"}]}').ok).toBe(true);
  });

  it("hallucinated (absent) texts are dropped but do NOT fail the pass", async () => {
    mocks.generateContent.mockResolvedValue({
      response: { text: () => '{"entities":[{"type":"PERSON","text":"Nobody Here"}]}', inferenceSource: "on_device" },
    });
    const out = await extractEntitiesOnDevice("Hello Jane.");
    expect(out.ok).toBe(true);
    expect(out.detections).toEqual([]);
  });

  it("extractEntitiesOnDevice marks a malformed list as not ok", async () => {
    mocks.generateContent.mockResolvedValue({ response: { text: () => '{"entities":[{}]}', inferenceSource: "on_device" } });
    const out = await extractEntitiesOnDevice("Hello Jane.");
    expect(out.ok).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/malformed/);
  });
});

// --------------------------------------------------------------------------------- Codex 7
describe("Codex 7: hard-question patterns are whitespace / newline safe", () => {
  it.each([
    ["list\nall the dates", "enumerate_all"],
    ["list   every   payment", "enumerate_all"],
    ["based on the letter,\nthen tell me", "multi_hop"],
    ["difference\tbetween A and B", "comparison"],
    ["sum of the charges", "compute"],
    ["which  one\nis   cheaper", "comparison"],
    ["step\nby\nstep", "multi_hop"],
  ])("%j -> %s", (q, family) => {
    expect(classifyHardQuestion(q)).toContain(family);
    const d = decideRoute({ redactedChars: 10, question: q, nanoAvailable: true });
    expect(d.route).toBe("offer_cloud");
  });

  it("plain questions still stay on-device", () => {
    expect(classifyHardQuestion("Ask\nfor a payment plan")).toEqual([]);
    expect(decideRoute({ redactedChars: 10, question: "  \n ", nanoAvailable: true }).route).toBe("on_device");
  });
});

// -------------------------------------------------------------------------------- Codex 11
describe("Codex 11: literal placeholder-looking strings never collide with map tokens", () => {
  it("doc -> map: a literal [PERSON_1] in the source is skipped; unmask leaves it literal", () => {
    const raw = "Template field [PERSON_1] was filled by Jane Doe.";
    const start = raw.indexOf("Jane Doe");
    const { masked, map } = mask(raw, [{ type: "PERSON", start, end: start + 8, text: "Jane Doe", source: "llm" }]);
    expect(map.entries.map((e) => e.token)).toEqual(["[PERSON_2]"]);
    expect(masked).toBe("Template field [PERSON_1] was filled by [PERSON_2].");
    expect(unmask("[PERSON_1] vs [PERSON_2]", map).text).toBe("[PERSON_1] vs Jane Doe");
  });

  it("reservedTexts: a literal token in the instruction is not handed out to the document", () => {
    const raw = "Jane Doe wrote.";
    const { map } = mask(raw, [{ type: "PERSON", start: 0, end: 8, text: "Jane Doe", source: "llm" }], {
      reservedTexts: ["Mention [PERSON_1] and [PERSON_2]"],
    });
    expect(map.entries[0]!.token).toBe("[PERSON_3]");
  });

  it("instruction -> map: extendMask skips literal tokens in the instruction AND in the raw doc", () => {
    const base = mapOf([["PERSON", "Jane Doe"]]); // [PERSON_1]
    const instr = "Copy [PERSON_2] and sign as Bob Roe";
    const s = instr.indexOf("Bob Roe");
    const out = extendMask(instr, [{ type: "PERSON", start: s, end: s + 7, text: "Bob Roe", source: "llm" }], base, {
      reservedTexts: ["doc has [PERSON_3] literally"],
    });
    expect(out.masked).toBe("Copy [PERSON_2] and sign as [PERSON_4]");
    expect(out.map.entries.map((e) => [e.token, e.original])).toEqual([
      ["[PERSON_1]", "Jane Doe"],
      ["[PERSON_4]", "Bob Roe"],
    ]);
    expect(base.entries).toHaveLength(1); // not mutated
    expect(unmask("[PERSON_2] / [PERSON_4] / [PERSON_1]", out.map).text).toBe("[PERSON_2] / Bob Roe / Jane Doe");
  });

  it("literalTokens recognizes multi-word types and ignores lower case / malformed ones", () => {
    expect([...literalTokens(["[CREDIT_CARD_12] [person_1] [PERSON_] [PERSON_3]"])]).toEqual([
      "[CREDIT_CARD_12]",
      "[PERSON_3]",
    ]);
  });
});

// ------------------------------------------------------------------- Codex 3 (core helper)
describe("Codex 3 (core): redactWithMap masks a draft instruction against the document map", () => {
  it("reuses doc tokens, adds new ones, masks emails, and the payload carries only tokens", () => {
    const docRaw = "Hi, Jane Doe here. Reach me at jane@example.test.";
    const s = docRaw.indexOf("Jane Doe");
    const doc = mask(docRaw, [
      { type: "PERSON", start: s, end: s + 8, text: "Jane Doe", source: "llm" },
      ...redact(docRaw).map.entries.map<Detection>((e) => ({ type: e.type, start: e.start, end: e.end, text: e.original, source: "regex" })),
    ]);
    const instr = "Thank Jane Doe, sign as Alice Smith, 42 Oak Street, cc alice@example.test";
    const a = instr.indexOf("Alice Smith");
    const b = instr.indexOf("42 Oak Street");
    const llm: Detection[] = [
      { type: "PERSON", start: a, end: a + 11, text: "Alice Smith", source: "llm" },
      { type: "ADDRESS", start: b, end: b + 13, text: "42 Oak Street", source: "llm" },
    ];
    const out = redactWithMap(instr, llm, doc.map, { reservedTexts: [docRaw] });
    expect(out.masked).toBe("Thank [PERSON_1], sign as [PERSON_2], [ADDRESS_1], cc [EMAIL_2]");
    const payload = buildCloudPayload(doc.masked, { kind: "draft", instruction: out.masked });
    expect(payload.preflight.ok).toBe(true);
    expect(findMapLeaks(payload.text, out.map)).toEqual([]);
    for (const v of ["Alice", "Oak Street", "alice@", "Jane Doe", "jane@"]) expect(payload.text).not.toContain(v);
    expect(unmask("Signed, [PERSON_2] of [ADDRESS_1]", out.map).text).toBe("Signed, Alice Smith of 42 Oak Street");
  });

  it("masks doc-map originals in the instruction even when the instruction pass found nothing", () => {
    const doc = mask("Jane Doe wrote.", [{ type: "PERSON", start: 0, end: 8, text: "Jane Doe", source: "llm" }]);
    expect(redactWithMap("Reply to Jane Doe kindly", [], doc.map).masked).toBe("Reply to [PERSON_1] kindly");
  });
});

// ---------------------------------------------------------------- Codex 14 (on-device side)
describe("Codex 14: on-device helpers require an explicitly reported ON_DEVICE source", () => {
  it("generateOnDevice refuses a missing source", async () => {
    mocks.generateContent.mockResolvedValue({ response: { text: () => "hi", inferenceSource: undefined } });
    await expect(generateOnDevice("hi")).rejects.toThrow(/did not report an inference source/);
    mocks.generateContent.mockResolvedValue({ response: { text: () => "hi", inferenceSource: "on_device" } });
    await expect(generateOnDevice("hi")).resolves.toEqual({ text: "hi", inferenceSource: "on_device", complete: true });
  });

  it("generateOnDeviceStream refuses a chunk with a missing source before showing it", async () => {
    mocks.generateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield { text: () => "secret-ish", inferenceSource: undefined };
      })(),
      response: Promise.resolve({ text: () => "secret-ish", inferenceSource: undefined }),
    });
    const chunks: string[] = [];
    await expect(generateOnDeviceStream("p", (c) => chunks.push(c))).rejects.toThrow(/did not report/);
    expect(chunks).toEqual([]);
  });

  it("on-device responses have no finishReason in the SDK and are complete", async () => {
    mocks.generateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield { text: () => "a", inferenceSource: "on_device" };
      })(),
      response: Promise.resolve({ text: () => "a", inferenceSource: "on_device" }),
    });
    await expect(generateOnDeviceStream("p", () => {})).resolves.toEqual({ text: "a", inferenceSource: "on_device", complete: true });
  });
});
