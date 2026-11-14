// Day 5 sweep: side-panel flows driven through the real markup (happy-dom). Every model call is a
// mock: firebase/* are mocked and the @rtr/core generation / extraction entry points are replaced.
// No network. All PII is synthetic.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const m = vi.hoisted(() => ({
  probeNano: vi.fn(),
  extract: vi.fn(),
  onDeviceStream: vi.fn(),
  draft: vi.fn(),
  cloud: vi.fn(),
}));

vi.mock("@rtr/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rtr/core")>();
  return {
    ...actual,
    isFirebaseInitialized: () => true,
    probeNano: m.probeNano,
    startDeviceModel: async () => {},
    extractEntitiesOnDevice: m.extract,
    generateOnDeviceStream: m.onDeviceStream,
    draftReplyOnDevice: m.draft,
    generateInCloudStream: m.cloud,
  };
});
vi.mock("../src/lib/sessionStore", () => ({
  saveMap: async () => {},
  clearMap: async () => {},
  clearAll: async () => {},
}));
vi.mock("../src/sidepanel/captureClient", () => ({
  listenForContextCaptures: () => {},
  requestTabText: vi.fn(),
}));

import { INSTRUCTION_PASS_BLOCKED, NOTHING_LEFT, STREAMING_LABEL } from "../src/lib/consentCopy";

const NAMES = ["Jane Doe", "Alice Smith"];
const DOC = "Hello, this is Jane Doe. Please confirm the appointment on Friday.";

/** Synthetic on-device extractor: finds the known names (verified spans). */
function fakeExtract(text: string) {
  const detections = NAMES.flatMap((n) => {
    const i = text.indexOf(n);
    return i >= 0 ? [{ type: "PERSON", start: i, end: i + n.length, text: n, source: "llm" }] : [];
  });
  return Promise.resolve({ detections, warnings: [], ok: true });
}

function cloudAnswer(text: string, extra: Partial<{ complete: boolean; finishReason: string }> = {}) {
  m.cloud.mockImplementation(async (_payload: string, onChunk: (t: string) => void) => {
    if (text) onChunk(text);
    return { text, inferenceSource: "in_cloud", complete: true, finishReason: "STOP", ...extra };
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

let deps: {
  setBadge: ReturnType<typeof vi.fn>;
  setPendingConsent: ReturnType<typeof vi.fn>;
  setProgress: ReturnType<typeof vi.fn>;
  refreshNano: ReturnType<typeof vi.fn>;
  setPrivacy: ReturnType<typeof vi.fn>;
};

async function setup(): Promise<void> {
  vi.resetModules();
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/sidepanel/index.html"), "utf8")
    .replace(/<link[^>]*>/g, ""); // happy-dom would try to fetch the stylesheet
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((s) => s.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
  const mod = await import("../src/sidepanel/redactPanel");
  deps = { setBadge: vi.fn(), setPendingConsent: vi.fn(), setProgress: vi.fn(), refreshNano: vi.fn(), setPrivacy: vi.fn() };
  mod.initRedactPanel(deps);
}

async function redactDoc(text = DOC): Promise<void> {
  const input = $<HTMLTextAreaElement>("redact-input");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  $("redact-btn").click();
  await flush();
  expect($<HTMLButtonElement>("explain-btn").disabled).toBe(false);
}

function lastPrivacy(): string {
  return deps.setPrivacy.mock.calls.at(-1)?.[0] as string;
}

beforeEach(async () => {
  m.probeNano.mockReset().mockResolvedValue("available");
  m.extract.mockReset().mockImplementation(fakeExtract);
  m.onDeviceStream.mockReset().mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
    onChunk("On-device answer.");
    return { text: "On-device answer.", inferenceSource: "on_device", complete: true };
  });
  m.draft.mockReset().mockImplementation(async (_d: string, _i: string, onChunk: (t: string) => void) => {
    onChunk("Dear [PERSON_1], confirmed.");
    return { kind: "ok", text: "Dear [PERSON_1], confirmed.", inferenceSource: "on_device" };
  });
  m.cloud.mockReset();
  cloudAnswer("Cloud answer for [PERSON_1].");
  await setup();
});

afterEach(() => {
  const d = $<HTMLDialogElement>("consent-dialog");
  if (d?.open) d.close();
});

describe("Codex 8: no concurrent actions while the cloud offer is being routed", () => {
  it("enters a busy state synchronously; Explain cannot start; the dialog opens only for the owner", async () => {
    await redactDoc();
    const probe = deferred<string>();
    m.probeNano.mockReturnValueOnce(probe.promise);
    $("explain-cloud-btn").click();
    // Synchronously busy: every action button is disabled before the probe resolves.
    for (const id of ["explain-btn", "draft-btn", "explain-cloud-btn", "draft-cloud-btn", "cloud-gate-btn", "redact-btn"]) {
      expect($<HTMLButtonElement>(id).disabled).toBe(true);
    }
    $("explain-btn").click();
    $("draft-btn").click();
    await flush(2);
    expect(m.onDeviceStream).not.toHaveBeenCalled();
    expect(m.draft).not.toHaveBeenCalled();
    probe.resolve("available");
    await flush();
    expect($<HTMLDialogElement>("consent-dialog").open).toBe(true);
    expect(m.onDeviceStream).not.toHaveBeenCalled();
  });

  it("double / rapid Send produces exactly one cloud call; payload is byte-identical to the preview", async () => {
    await redactDoc();
    $("explain-cloud-btn").click();
    await flush();
    const preview = $("consent-preview").textContent!;
    expect(preview).toContain("[PERSON_1]");
    expect(preview).not.toContain("Jane Doe");
    $("consent-send").click();
    $("consent-send").click();
    await flush();
    $("consent-send").click();
    await flush();
    expect(m.cloud).toHaveBeenCalledTimes(1);
    expect(m.cloud.mock.calls[0]![0]).toBe(preview);
    expect($("explain-text").textContent).toBe("Cloud answer for Jane Doe.");
  });

  it("Cancel then Send sends nothing", async () => {
    await redactDoc();
    $("explain-cloud-btn").click();
    await flush();
    $("consent-cancel").click();
    await flush();
    $("consent-send").click();
    await flush();
    expect(m.cloud).not.toHaveBeenCalled();
    expect($("explain-step").textContent).toMatch(/Nothing was sent/);
  });
});

describe("Codex 3: the draft instruction gets its own on-device entity pass", () => {
  it("masks names (reusing doc tokens) and emails in the instruction; preview == sent; unmasked locally", async () => {
    await redactDoc();
    $<HTMLInputElement>("draft-instruction").value = "Thank Jane Doe and sign as Alice Smith, cc alice@example.test";
    $("draft-cloud-btn").click();
    await flush();
    const preview = $("consent-preview").textContent!;
    expect(preview).toContain("Thank [PERSON_1] and sign as [PERSON_2], cc [EMAIL_1]");
    for (const v of ["Alice", "Jane Doe", "alice@"]) expect(preview).not.toContain(v);
    expect(m.extract).toHaveBeenCalledWith("Thank Jane Doe and sign as Alice Smith, cc alice@example.test");
    expect($<HTMLButtonElement>("consent-send").disabled).toBe(false);
    cloudAnswer("Dear [PERSON_1], thanks. [PERSON_2]");
    $("consent-send").click();
    await flush();
    expect(m.cloud.mock.calls[0]![0]).toBe(preview);
    expect($("draft-text").textContent).toBe("Dear Jane Doe, thanks. Alice Smith");
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(false);
  });

  it.each([
    ["failed (throws)", () => m.extract.mockImplementation((t: string) => (t === DOC ? fakeExtract(t) : Promise.reject(new Error("x"))))],
    ["failed (malformed)", () => m.extract.mockImplementation((t: string) => (t === DOC ? fakeExtract(t) : Promise.resolve({ detections: [], warnings: [], ok: false })))],
    ["unavailable", () => m.probeNano.mockResolvedValue("unavailable")],
  ])("blocks Send when the instruction pass is %s", async (_label, arrange) => {
    await redactDoc();
    arrange();
    $<HTMLInputElement>("draft-instruction").value = "Sign as Alice Smith";
    $("draft-cloud-btn").click();
    await flush();
    expect($<HTMLButtonElement>("consent-send").disabled).toBe(true);
    expect($("consent-blocked").textContent).toContain(INSTRUCTION_PASS_BLOCKED);
    $("consent-send").click();
    await flush();
    expect(m.cloud).not.toHaveBeenCalled();
  });

  it("no instruction: no instruction pass and Send is allowed", async () => {
    await redactDoc();
    m.extract.mockClear();
    $("draft-cloud-btn").click();
    await flush();
    expect(m.extract).not.toHaveBeenCalled();
    expect($<HTMLButtonElement>("consent-send").disabled).toBe(false);
  });
});

describe("Codex 9: privacy line stays honest after a cloud send", () => {
  it("a later on-device run does not claim nothing left; New document resets the per-doc part", async () => {
    await redactDoc();
    $("explain-cloud-btn").click();
    await flush();
    const chars = $("consent-preview").textContent!.length;
    $("consent-send").click();
    await flush();
    expect(lastPrivacy()).toMatch(/^Sent /);
    $("explain-btn").click();
    await flush();
    expect(m.onDeviceStream).toHaveBeenCalledTimes(1);
    expect(lastPrivacy()).not.toBe(NOTHING_LEFT);
    expect(lastPrivacy()).toContain(`Earlier, ${chars.toLocaleString("en-US")} characters of redacted text from this document`);

    $("newdoc-btn").click();
    await flush();
    await redactDoc("A different note from Jane Doe about lunch.");
    $("explain-btn").click();
    await flush();
    expect(lastPrivacy()).toMatch(/nothing from this document has left this device\. Earlier in this session/);
  });

  it("without any cloud send the line is still 'Nothing has left this device.'", async () => {
    await redactDoc();
    $("explain-btn").click();
    await flush();
    expect(lastPrivacy()).toBe(NOTHING_LEFT);
  });
});

describe("Codex 10: edits invalidate shown results", () => {
  it("editing the document clears Explain / Draft results and hides Copy draft", async () => {
    await redactDoc();
    $("explain-btn").click();
    await flush();
    $("draft-btn").click();
    await flush();
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(false);
    expect($("explain-text").textContent).toBe("On-device answer.");
    const input = $<HTMLTextAreaElement>("redact-input");
    input.value = DOC + " Edited.";
    input.dispatchEvent(new Event("input"));
    expect($("explain-text").textContent).toBe("");
    expect($("explain-result").hidden).toBe(true);
    expect($("draft-text").textContent).toBe("");
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(true);
    expect($("explain-step").textContent).toMatch(/Redact again/);
  });

  it("changing the instruction after a draft withdraws Copy draft", async () => {
    await redactDoc();
    $<HTMLInputElement>("draft-instruction").value = "Keep it short";
    $("draft-btn").click();
    await flush();
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(false);
    const instr = $<HTMLInputElement>("draft-instruction");
    instr.value = "Keep it short "; // whitespace-only change: still the same instruction
    instr.dispatchEvent(new Event("input"));
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(false);
    instr.value = "Decline politely";
    instr.dispatchEvent(new Event("input"));
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(true);
    expect($("draft-step").textContent).toMatch(/instruction changed/);
  });

  it("an edit while the on-device answer streams discards the result when it finishes", async () => {
    await redactDoc();
    const gate = deferred<void>();
    m.onDeviceStream.mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
      onChunk("Partial");
      await gate.promise;
      return { text: "Old answer.", inferenceSource: "on_device", complete: true };
    });
    $("explain-btn").click();
    await flush();
    const input = $<HTMLTextAreaElement>("redact-input");
    input.value = "Completely different text.";
    input.dispatchEvent(new Event("input"));
    gate.resolve();
    await flush();
    expect($("explain-text").textContent).toBe("");
    expect($("explain-step").textContent).toMatch(/result was discarded/);
    expect(deps.setBadge).not.toHaveBeenCalled();
  });
});

describe("Codex 12: streamed text is labeled provisional until validated", () => {
  it("shows the streaming label and no badge until the answer is final", async () => {
    await redactDoc();
    const gate = deferred<void>();
    m.onDeviceStream.mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
      onChunk("Half");
      await gate.promise;
      return { text: "Half answer.", inferenceSource: "on_device", complete: true };
    });
    $("explain-btn").click();
    await flush();
    expect($("explain-source").textContent).toBe(STREAMING_LABEL);
    expect($("explain-text").classList.contains("provisional")).toBe(true);
    expect($("explain-step").textContent).not.toMatch(/Done/);
    expect(deps.setBadge).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect($("explain-source").textContent).toBe("on_device");
    expect($("explain-text").classList.contains("provisional")).toBe(false);
    expect($("explain-step").textContent).toBe("Done.");
  });

  it("a failed on-device stream clears the partial text", async () => {
    await redactDoc();
    m.onDeviceStream.mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
      onChunk("Half");
      throw new Error("boom");
    });
    m.probeNano.mockResolvedValueOnce("available").mockResolvedValue("available");
    $("explain-btn").click();
    await flush();
    expect($("explain-text").textContent).toBe("");
    expect($("explain-result").hidden).toBe(true);
  });
});

describe("Codex 13 / 15: empty or incomplete cloud answers are never 'Done.'", () => {
  it("empty cloud answer: error, honest 'sent but no answer' status, no success badge", async () => {
    await redactDoc();
    cloudAnswer("   ");
    $("explain-cloud-btn").click();
    await flush();
    $("consent-send").click();
    await flush();
    expect(m.cloud).toHaveBeenCalledTimes(1);
    expect($("explain-step").textContent).toBe("Failed.");
    expect($("explain-error").hidden).toBe(false);
    expect($("explain-error").textContent).toMatch(/empty answer.*was sent/);
    expect(lastPrivacy()).toMatch(/^Sent .* but no answer came back/);
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it("MAX_TOKENS: partial text shown, labeled incomplete, no Done, no Copy draft", async () => {
    await redactDoc();
    cloudAnswer("Dear [PERSON_1], we", { complete: false, finishReason: "MAX_TOKENS" });
    $("draft-cloud-btn").click();
    await flush();
    $("consent-send").click();
    await flush();
    expect($("draft-text").textContent).toBe("Dear Jane Doe, we");
    expect($("draft-step").textContent).toMatch(/^Incomplete \(MAX_TOKENS\)/);
    expect($("draft-step").textContent).not.toMatch(/Done/);
    expect($<HTMLButtonElement>("draft-copy-btn").hidden).toBe(true);
  });

  it("a network failure after Send clears the partial answer and never reports success", async () => {
    await redactDoc();
    m.cloud.mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
      onChunk("Half an ans");
      throw new Error("NetworkError");
    });
    $("explain-cloud-btn").click();
    await flush();
    $("consent-send").click();
    await flush();
    expect($("explain-text").textContent).toBe("");
    expect($("explain-step").textContent).toBe("Failed.");
    expect(lastPrivacy()).toMatch(/^Tried to send/);
    expect(deps.setBadge).not.toHaveBeenCalled();
  });
});
