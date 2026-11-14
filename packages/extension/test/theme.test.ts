// UI polish pass: theme system, chip rendering, picker storage, copy/label variants and WCAG AA
// contrast for all five themes. Presentational only: the panel flows below reuse panel.test.ts's
// mocks and assert that themes never change what is sent. All PII is synthetic.
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

import { NOTHING_LEFT, cloudStatusLine, cloudEmptyLine, onDevicePrivacyLine } from "../src/lib/consentCopy";
import { renderCountChips, renderMaskedChips } from "../src/sidepanel/chips";
import {
  CHIP_FAMILIES,
  THEMES,
  THEME_IDS,
  THEME_STORAGE_KEY,
  applyTheme,
  initThemePicker,
  loadTheme,
  privacyCopy,
  themeCssVars,
  type ThemeId,
  type ThemeTokens,
} from "../src/sidepanel/theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDEPANEL = join(HERE, "../src/sidepanel");
const DOC = "Hello, this is Jane Doe. Please confirm the appointment on Friday.";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function loadMarkup(): void {
  const html = readFileSync(join(SIDEPANEL, "index.html"), "utf8").replace(/<link[^>]*>/g, "");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((s) => s.remove());
  document.body.className = parsed.body.className;
  document.body.removeAttribute("style");
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
}

let setPrivacy: ReturnType<typeof vi.fn>;

async function setupPanel(theme: ThemeId): Promise<void> {
  vi.resetModules();
  loadMarkup();
  // Fresh module graph so redactPanel state does not leak between runs; theme applied first.
  const themeMod = await import("../src/sidepanel/theme");
  themeMod.applyTheme(theme);
  const mod = await import("../src/sidepanel/redactPanel");
  setPrivacy = vi.fn();
  mod.initRedactPanel({ setBadge: vi.fn(), setPendingConsent: vi.fn(), setProgress: vi.fn(), refreshNano: vi.fn(), setPrivacy });
}

async function redactDoc(text = DOC): Promise<void> {
  const input = $<HTMLTextAreaElement>("redact-input");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  $("redact-btn").click();
  await flush();
  expect($<HTMLButtonElement>("explain-btn").disabled).toBe(false);
}

// ------------------------------------------------------------------------- chrome.storage mock
let stored: Record<string, unknown>;
const storageSet = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(stored, items);
});
const storageGet = vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {}));

beforeEach(() => {
  stored = {};
  storageSet.mockClear();
  storageGet.mockClear();
  vi.stubGlobal("chrome", { storage: { local: { get: storageGet, set: storageSet } } });
  m.probeNano.mockReset().mockResolvedValue("available");
  m.extract.mockReset().mockImplementation((text: string) => {
    const i = text.indexOf("Jane Doe");
    const detections = i >= 0 ? [{ type: "PERSON", start: i, end: i + 8, text: "Jane Doe", source: "llm" }] : [];
    return Promise.resolve({ detections, warnings: [], ok: true });
  });
  m.onDeviceStream.mockReset().mockImplementation(async (_p: string, onChunk: (t: string) => void) => {
    onChunk("On-device answer.");
    return { text: "On-device answer.", inferenceSource: "on_device", complete: true };
  });
  m.draft.mockReset().mockImplementation(async (_d: string, _i: string, onChunk: (t: string) => void) => {
    onChunk("Dear [PERSON_1], confirmed.");
    return { kind: "ok", text: "Dear [PERSON_1], confirmed.", inferenceSource: "on_device" };
  });
  m.cloud.mockReset().mockImplementation(async (_payload: string, onChunk: (t: string) => void) => {
    onChunk("Cloud answer for [PERSON_1].");
    return { text: "Cloud answer for [PERSON_1].", inferenceSource: "in_cloud", complete: true, finishReason: "STOP" };
  });
});

afterEach(() => {
  const d = $<HTMLDialogElement>("consent-dialog");
  if (d?.open) d.close();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------ every theme
const MASKED = "Patient [PERSON_1] ([EMAIL_1]) has record [MRN_1]; see [PERSON_1] again. <b>not html</b>";

describe("each theme applies and the panel renders", () => {
  it.each(THEME_IDS)("%s", async (id) => {
    loadMarkup();
    expect(applyTheme(id)).toBe(id);
    const body = document.body;
    expect(body.classList.contains(`theme-${id}`)).toBe(true);
    for (const other of THEME_IDS) if (other !== id) expect(body.classList.contains(`theme-${other}`)).toBe(false);
    for (const [name, value] of Object.entries(themeCssVars(id))) expect(body.style.getPropertyValue(name)).toBe(value);
    expect(body.style.getPropertyValue("--fg")).toBe(THEMES[id].tokens.fg);

    for (const elId of [
      "badge", "theme-select", "cloud-gate-btn", "redact-input", "redact-btn", "explain-btn", "draft-btn",
      "explain-cloud-btn", "draft-cloud-btn", "privacy", "redact-preview", "redact-masked", "redact-original",
      "consent-dialog", "consent-preview", "consent-send", "consent-cancel", "debug-token", "hello-btn",
    ]) {
      expect($(elId), elId).not.toBeNull();
    }

    const pre = $("redact-masked");
    renderMaskedChips(pre, MASKED);
    expect(pre.textContent).toBe(MASKED); // same content as the plain preview
    const chips = Array.from(pre.querySelectorAll("span.chip"));
    expect(chips.map((c) => c.textContent)).toEqual(["[PERSON_1]", "[EMAIL_1]", "[MRN_1]", "[PERSON_1]"]);
    expect(chips[0]!.classList.contains("chip--person")).toBe(true);
    expect(chips[1]!.classList.contains("chip--email")).toBe(true);
    expect(chips[2]!.classList.contains("chip--mrn")).toBe(true);
    for (const c of chips) expect(c.children.length).toBe(0); // text only
    expect(pre.querySelector("b")).toBeNull(); // markup-looking text stays text
  });

  it("count chips keep the same text as the plain counts line", () => {
    loadMarkup();
    const p = $("redact-counts");
    renderCountChips(p, [{ type: "PERSON", count: 2 }, { type: "EMAIL", count: 1 }], "No identifiers detected.");
    expect(p.textContent).toBe("PERSON: 2, EMAIL: 1");
    expect(p.querySelectorAll("span.chip--count").length).toBe(2);
    renderCountChips(p, [], "No identifiers detected.");
    expect(p.textContent).toBe("No identifiers detected.");
  });

  it("side-panel sources never use HTML-string sinks", () => {
    for (const f of ["chips.ts", "theme.ts", "redactPanel.ts", "main.ts"]) {
      const src = readFileSync(join(SIDEPANEL, f), "utf8").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it("styles.css :root mirrors the Calm tokens exactly", () => {
    const css = readFileSync(join(SIDEPANEL, "styles.css"), "utf8");
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    const declared = Object.fromEntries(Array.from(root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g), (x) => [x[1], x[2]!.trim()]));
    for (const [name, value] of Object.entries(themeCssVars("calm"))) expect(declared[name], name).toBe(value);
  });

  it("styles.css and index.html load nothing external", () => {
    const css = readFileSync(join(SIDEPANEL, "styles.css"), "utf8");
    const html = readFileSync(join(SIDEPANEL, "index.html"), "utf8");
    expect(css).not.toMatch(/url\(|@import|https?:/);
    expect(html).not.toMatch(/https?:/);
  });
});

// ---------------------------------------------------------------------------------- picker
describe("theme picker + storage", () => {
  it("fills options, applies the stored theme on load", async () => {
    loadMarkup();
    stored[THEME_STORAGE_KEY] = "midnight";
    const select = $<HTMLSelectElement>("theme-select");
    const applied = vi.fn();
    await initThemePicker(select, document.body, applied);
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...THEME_IDS]);
    expect(select.value).toBe("midnight");
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
    expect(applied).toHaveBeenCalledWith("midnight");
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("changing the select stores ONLY the theme id", async () => {
    loadMarkup();
    const select = $<HTMLSelectElement>("theme-select");
    await initThemePicker(select);
    select.value = "paper";
    select.dispatchEvent(new Event("change"));
    await flush(2);
    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(storageSet.mock.calls[0]![0]).toEqual({ [THEME_STORAGE_KEY]: "paper" });
    expect(Object.keys(stored)).toEqual([THEME_STORAGE_KEY]);
    expect(document.body.classList.contains("theme-paper")).toBe(true);
  });

  it.each([["neon"], [42], [null], [{ id: "calm" }]])("invalid stored value %j falls back to calm", async (bad) => {
    stored[THEME_STORAGE_KEY] = bad;
    expect(await loadTheme()).toBe("calm");
    loadMarkup();
    applyTheme("terminal");
    await initThemePicker($<HTMLSelectElement>("theme-select"));
    expect(document.body.classList.contains("theme-calm")).toBe(true);
  });

  it("missing chrome.storage falls back to calm", async () => {
    vi.stubGlobal("chrome", undefined);
    expect(await loadTheme()).toBe("calm");
  });
});

// ------------------------------------------------------------------------ chill copy mapping
describe("Chill status copy is a pure mapping of the same state", () => {
  it("swaps only the exact 'Nothing has left this device.' line", () => {
    expect(privacyCopy(NOTHING_LEFT, "chill")).toBe(THEMES.chill.nothingLeft);
    expect(privacyCopy(NOTHING_LEFT, "chill")).toMatch(/^Nothing left your device/);
    for (const id of THEME_IDS) if (id !== "chill") expect(privacyCopy(NOTHING_LEFT, id)).toBe(NOTHING_LEFT);
  });

  it("Earlier / Sent / failure / empty lines are never replaced", () => {
    const lines = [
      onDevicePrivacyLine(1234, 1234),
      onDevicePrivacyLine(0, 99),
      cloudStatusLine(321),
      cloudEmptyLine(321),
      "Tried to send 12 characters of redacted text to Firebase AI Logic (Gemini cloud); the request failed. The placeholder map stayed here.",
      "Nothing has been processed yet.",
      `${NOTHING_LEFT} `,
    ];
    expect(lines[0]).toMatch(/^This answer was generated on-device\. Earlier, 1,234 characters/);
    expect(lines[2]).toMatch(/^Sent 321 characters/);
    for (const id of THEME_IDS) for (const line of lines) expect(privacyCopy(line, id)).toBe(line);
  });
});

// --------------------------------------------------------------------------- terminal theme
describe("Terminal theme: labels only, same handlers, same payload", () => {
  it("shows command labels with plain accessible names; other themes restore the plain labels", () => {
    loadMarkup();
    applyTheme("terminal");
    expect($("redact-btn").textContent).toBe("$ redact");
    expect($("redact-btn").getAttribute("aria-label")).toBe("Redact");
    expect($("explain-btn").textContent).toBe("$ explain --on-device");
    expect($("explain-btn").getAttribute("aria-label")).toBe("Explain on-device");
    expect($("draft-btn").textContent).toBe("$ draft --on-device");
    expect($("explain-cloud-btn").textContent).toMatch(/^\$ cloud --deeper/);
    expect($("explain-cloud-btn").getAttribute("aria-label")).toBe("Use cloud for a deeper explanation");
    applyTheme("calm");
    expect($("redact-btn").textContent).toBe("Redact");
    expect($("redact-btn").hasAttribute("aria-label")).toBe(false);
    expect($("explain-cloud-btn").textContent).toBe("Explain");
    expect($("explain-cloud-btn").getAttribute("aria-label")).toBe("Use cloud for a deeper explanation");
  });

  it("clicking the command-labelled buttons runs the same on-device flows", async () => {
    await setupPanel("terminal");
    expect($("redact-btn").textContent).toBe("$ redact");
    await redactDoc();
    expect($("redact-masked").textContent).toContain("[PERSON_1]");
    expect($("redact-masked").querySelector("span.chip--person")?.textContent).toBe("[PERSON_1]");
    $("explain-btn").click();
    await flush();
    expect(m.onDeviceStream).toHaveBeenCalledTimes(1);
    expect($("explain-text").textContent).toBe("On-device answer.");
    expect(setPrivacy.mock.calls.at(-1)?.[0]).toBe(NOTHING_LEFT);
    $("draft-btn").click();
    await flush();
    expect(m.draft).toHaveBeenCalledTimes(1);
    expect($("draft-text").textContent).toBe("Dear Jane Doe, confirmed.");
  });

  async function consentPreviewUnder(theme: ThemeId): Promise<{ preview: string; sent: string; original: string }> {
    m.cloud.mockClear();
    await setupPanel(theme);
    await redactDoc();
    const original = $("redact-original").textContent ?? "";
    $("explain-cloud-btn").click();
    await flush();
    const preview = $("consent-preview").textContent ?? "";
    $("consent-send").click();
    await flush();
    expect(m.cloud).toHaveBeenCalledTimes(1);
    return { preview, sent: m.cloud.mock.calls[0]![0] as string, original };
  }

  it("the before/after view never alters the payload: consent preview identical under calm and terminal", async () => {
    const calm = await consentPreviewUnder("calm");
    const term = await consentPreviewUnder("terminal");
    expect(term.preview).toBe(calm.preview);
    expect(term.sent).toBe(calm.sent);
    expect(term.sent).toBe(term.preview);
    expect(term.original).toBe(DOC); // display only, in the panel
    expect(term.preview).not.toContain("Jane Doe");
    expect(term.preview).toContain("[PERSON_1]");
  });
});

// ------------------------------------------------------------------- chill field shape (CSS)
// happy-dom does not resolve var() through class rules, so this parses styles.css directly and
// resolves the winning border-radius per field class by hand (theme-scoped rule beats base rule).
type CssRule = { selectors: string[]; decls: Record<string, string> };
function parseCss(): CssRule[] {
  const css = readFileSync(join(SIDEPANEL, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (x) => ({
    selectors: x[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    decls: Object.fromEntries(Array.from(x[2]!.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g), (d) => [d[1]!, d[2]!.trim()])),
  }));
}
const FIELD_CLASSES = ["redact-input", "text-input", "theme-select", "masked", "debug-token", "consent-preview"] as const;

describe("Chill fields are soft rectangles, not pills", () => {
  const rules = parseCss();
  const vars = (theme: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of rules) {
      if (!r.selectors.includes(":root") && !r.selectors.includes(`.theme-${theme}`)) continue;
      for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--")) out[k] = v;
    }
    return out;
  };
  const resolvePx = (value: string, v: Record<string, string>): number => {
    const sub = value.replace(/var\((--[a-z0-9-]+)\)/g, (_, n: string) => v[n] ?? "NaN");
    const calc = /^calc\(\s*([\d.]+)px\s*\/\s*([\d.]+)\s*\)$/.exec(sub);
    if (calc) return Number(calc[1]) / Number(calc[2]);
    if (sub.trim() === "0") return 0;
    const px = /^([\d.]+)px$/.exec(sub.trim());
    if (!px) throw new Error(`unresolved radius ${value} -> ${sub}`);
    return Number(px[1]);
  };
  /** Winning declaration for `.cls` under `.theme-<theme>`: last theme-scoped rule, else last base rule. */
  const winning = (cls: string, prop: string, theme: string): string | undefined => {
    let base: string | undefined;
    let scoped: string | undefined;
    for (const r of rules) {
      if (!(prop in r.decls)) continue;
      if (r.selectors.includes(`.${cls}`)) base = r.decls[prop];
      if (r.selectors.includes(`.theme-${theme} .${cls}`)) scoped = r.decls[prop];
    }
    return scoped ?? base;
  };

  it("the markup fields carry the classes these rules target (no markup change needed)", () => {
    loadMarkup();
    expect($("redact-input").tagName).toBe("TEXTAREA");
    expect($("redact-input").classList.contains("redact-input")).toBe(true);
    expect($("draft-instruction").classList.contains("text-input")).toBe(true);
    expect($("consent-preview").tagName).toBe("PRE");
    expect($("consent-preview").classList.contains("masked")).toBe(true);
    expect($("theme-select").classList.contains("theme-select")).toBe(true);
  });

  it("main textarea, draft instruction and consent preview resolve from Chill's card radius", () => {
    const cardRadius = winning("card", "border-radius", "chill");
    expect(cardRadius).toBe("var(--radius)");
    const v = vars("chill");
    const card = resolvePx(cardRadius!, v);
    expect(card).toBe(22);
    // Multi-line fields use the card radius exactly; the single-line draft field uses half of it
    // (a 22px radius on a ~32px tall input would clamp back into a stadium).
    expect(winning("redact-input", "border-radius", "chill")).toBe("var(--radius)");
    expect(winning("masked", "border-radius", "chill")).toBe("var(--radius)"); // consent preview
    expect(winning("text-input", "border-radius", "chill")).toBe("calc(var(--radius) / 2)");
    expect(resolvePx(winning("text-input", "border-radius", "chill")!, v)).toBe(card / 2);
    // Same border width as the Chill card.
    const chillCard = rules.find((r) => r.selectors.includes(".theme-chill .card"))!;
    for (const cls of ["redact-input", "masked", "text-input", "theme-select", "debug-token"]) {
      expect(winning(cls, "border-width", "chill"), cls).toBe(chillCard.decls["border-width"]);
    }
  });

  it("no Chill field resolves to a pill radius (>= 999px or 50%)", () => {
    const v = vars("chill");
    expect(v["--radius-btn"]).toBe("999px"); // buttons stay chunky pills by design
    for (const cls of FIELD_CLASSES) {
      const value = winning(cls, "border-radius", "chill");
      if (cls === "consent-preview") {
        expect(value, cls).toBeUndefined(); // shape comes from .masked
        continue;
      }
      expect(value, cls).toBeDefined();
      expect(value, cls).not.toMatch(/50%|--radius-btn|--radius-chip/);
      expect(resolvePx(value!, v), cls).toBeLessThan(999);
    }
  });

  it("other themes' field rules are untouched: fix is scoped to .theme-chill, base rules unchanged", () => {
    const fieldRe = new RegExp(`\\.(${FIELD_CLASSES.join("|")})\\b`);
    const themed = rules.flatMap((r) =>
      r.selectors.filter((s) => /^\.theme-[a-z]+ /.test(s) && fieldRe.test(s)).map((s) => `${s} {${Object.keys(r.decls).join(",")}}`),
    );
    expect(themed.filter((s) => !s.startsWith(".theme-chill "))).toEqual([".theme-terminal .redact-input {caret-color}"]);
    // Known base values (what Calm/Midnight/Terminal/Paper resolve to).
    for (const cls of ["redact-input", "text-input", "theme-select", "masked", "debug-token"]) {
      expect(winning(cls, "border-radius", "calm"), cls).toBe("var(--radius-btn)");
      for (const id of THEME_IDS.filter((t) => t !== "chill")) {
        expect(winning(cls, "border-radius", id), `${id} ${cls}`).toBe("var(--radius-btn)");
        expect(winning(cls, "border-width", id), `${id} ${cls}`).toBeUndefined(); // 1px from shorthand
      }
    }
  });

  // Message boxes: status line, error and ok boxes used --radius-btn (999px in Chill) too.
  const MESSAGE_CLASSES = ["status-line", "error", "ok"] as const;

  it("Chill message boxes resolve to half the card radius, never a pill", () => {
    const v = vars("chill");
    const card = resolvePx(winning("card", "border-radius", "chill")!, v);
    for (const cls of MESSAGE_CLASSES) {
      const value = winning(cls, "border-radius", "chill");
      // Mostly single-line (~36-38px tall): the full 22px would clamp to a stadium, so half of it.
      expect(value, cls).toBe("calc(var(--radius) / 2)");
      expect(value, cls).not.toMatch(/50%|--radius-btn|--radius-chip/);
      const px = resolvePx(value!, v);
      expect(px, cls).toBe(card / 2);
      expect(px, cls).toBeLessThan(999);
    }
    // Buttons and chips stay pills in Chill.
    expect(winning("chip", "border-radius", "chill")).toBe("var(--radius-chip)");
    expect(resolvePx("var(--radius-chip)", v)).toBe(999);
    expect(resolvePx("var(--radius-btn)", v)).toBe(999);
  });

  it("other themes' message boxes keep their previous radius (--radius-btn, unscoped)", () => {
    const previous: Record<string, number> = { calm: 8, midnight: 8, terminal: 2, paper: 4 };
    const themed = rules.flatMap((r) =>
      r.selectors.filter((s) => /^\.theme-[a-z]+ \.(status-line|error|ok)\b/.test(s) && !s.startsWith(".theme-chill ")),
    );
    expect(themed).toEqual([]);
    for (const id of THEME_IDS.filter((t) => t !== "chill")) {
      for (const cls of MESSAGE_CLASSES) {
        const value = winning(cls, "border-radius", id);
        expect(value, `${id} ${cls}`).toBe("var(--radius-btn)");
        expect(resolvePx(value!, vars(id)), `${id} ${cls}`).toBe(previous[id]);
      }
    }
  });
});

// ------------------------------------------------------------------------------- contrast
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function rgb(hex: string): [number, number, number] {
  const h = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!h) throw new Error(`bad colour ${hex}`);
  const n = parseInt(h[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Colour `c` under a black overlay of opacity `alpha` (Terminal scanlines). */
function darken(c: [number, number, number], alpha: number): [number, number, number] {
  return c.map((v) => v * (1 - alpha)) as [number, number, number];
}
/** `top` composited over `base` at `alpha` (glows). */
function blend(top: string, base: string, alpha: number): [number, number, number] {
  const t = rgb(top);
  const b = rgb(base);
  return t.map((v, i) => v * alpha + b[i]! * (1 - alpha)) as [number, number, number];
}

type Pair = [label: string, fg: string, bg: string];

function textPairs(t: ThemeTokens): Pair[] {
  const pairs: Pair[] = [];
  for (const surface of ["bg", "bg2", "card", "inputBg"] as const) {
    pairs.push([`fg/${surface}`, t.fg, t[surface]], [`mutedFg/${surface}`, t.mutedFg, t[surface]]);
  }
  pairs.push(
    ["linkFg/card", t.linkFg, t.card],
    ["linkFg/bg", t.linkFg, t.bg],
    ["primaryFg/primaryBg", t.primaryFg, t.primaryBg],
    ["disabledFg/disabledBg", t.disabledFg, t.disabledBg],
    ["badgeFg/badgeBg", t.badgeFg, t.badgeBg],
    ["deviceFg/deviceBg", t.deviceFg, t.deviceBg],
    ["cloudFg/cloudBg", t.cloudFg, t.cloudBg],
    ["errorFg/errorBg", t.errorFg, t.errorBg],
    ["okFg/okBg", t.okFg, t.okBg],
    ["statusFg/statusBg", t.statusFg, t.statusBg],
  );
  for (const fam of CHIP_FAMILIES) pairs.push([`chip.${fam}`, t.chips[fam].fg, t.chips[fam].bg]);
  return pairs;
}

function uiPairs(t: ThemeTokens): Pair[] {
  return [
    ["accent(focus)/bg", t.accent, t.bg],
    ["accent(focus)/bg2", t.accent, t.bg2],
    ["accent(focus)/card", t.accent, t.card],
    ["primaryBorder/card", t.primaryBorder, t.card],
    ["primaryBorder/bg", t.primaryBorder, t.bg],
    ["mutedFg(control border)/inputBg", t.mutedFg, t.inputBg],
  ];
}

describe("WCAG AA contrast for every theme", () => {
  it.each(THEME_IDS)("%s: text >= 4.5:1, UI components >= 3:1 (worst-case gradient stop / overlay)", (id) => {
    const t = THEMES[id].tokens;
    const failures: string[] = [];
    for (const [label, fg, bg] of textPairs(t)) {
      const r = Math.min(ratio(rgb(fg), rgb(bg)), ratio(darken(rgb(fg), t.scanlineAlpha), rgb(bg)));
      if (r < 4.5) failures.push(`${label} ${r.toFixed(2)}`);
    }
    for (const [label, fg, bg] of uiPairs(t)) {
      const r = ratio(rgb(fg), rgb(bg));
      if (r < 3) failures.push(`${label} ${r.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("midnight: heading text stays AA over its cyan glow (worst case 50% glow over bg)", () => {
    const t = THEMES.midnight.tokens;
    expect(ratio(rgb(t.fg), blend(t.accent, t.bg, 0.5))).toBeGreaterThanOrEqual(4.5);
  });

  it("reports the tightest pair per theme (for the polish notes)", () => {
    for (const id of THEME_IDS) {
      const t = THEMES[id].tokens;
      const worst = textPairs(t)
        .map(([l, f, b]) => [l, Math.min(ratio(rgb(f), rgb(b)), ratio(darken(rgb(f), t.scanlineAlpha), rgb(b)))] as const)
        .sort((a, b) => a[1] - b[1])[0]!;
      expect(worst[1]).toBeGreaterThanOrEqual(4.5);
      console.info(`[contrast] ${id}: tightest text pair ${worst[0]} = ${worst[1].toFixed(2)}:1`);
    }
  });
});
