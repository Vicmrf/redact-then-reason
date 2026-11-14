// Logo + icons (presentational assets only): header logo in every theme, SVG hygiene, manifest
// icon PNGs (signature + IHDR size, source and dist), and 3:1 graphical contrast of the logo.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOGO_GRADIENT, THEMES, THEME_IDS, applyTheme, themeCssVars } from "../src/sidepanel/theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const SIDEPANEL = join(PKG, "src/sidepanel");
const LOGO_DIR = join(PKG, "src/assets/logo");
const SVG_NS = "http://www.w3.org/2000/svg";

function loadMarkup(): void {
  const html = readFileSync(join(SIDEPANEL, "index.html"), "utf8").replace(/<link[^>]*>/g, "");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((s) => s.remove());
  document.body.className = parsed.body.className;
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-logo");
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
  // Only the logo rules from styles.css, so computed display can be checked in happy-dom.
  const css = readFileSync(join(SIDEPANEL, "styles.css"), "utf8");
  const logoRules = Array.from(css.matchAll(/[^{}]*rtr-logo[^{}]*\{[^}]*\}/g), (m) => m[0].replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
  const style = document.createElement("style");
  style.textContent = logoRules;
  document.head.querySelectorAll("style[data-test-logo]").forEach((s) => s.remove());
  style.setAttribute("data-test-logo", "");
  document.head.append(style);
}

function assertSafeSvg(svg: Element): void {
  for (const tag of ["image", "script", "foreignObject", "use", "a", "style"]) {
    expect(svg.getElementsByTagName(tag).length, tag).toBe(0);
  }
  for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase(), `${el.tagName} ${attr.name}`).not.toMatch(/^on|href$/);
      expect(attr.value, `${el.tagName} ${attr.name}`).not.toMatch(/https?:|data:|javascript:/i);
      const url = /url\(([^)]*)\)/.exec(attr.value);
      if (url) expect(url[1], "only local fragment refs").toMatch(/^#rtr-logo-grad$/);
    }
  }
}

describe("header logo renders in every theme", () => {
  it.each(THEME_IDS)("%s", (id) => {
    loadMarkup();
    applyTheme(id);
    const header = document.querySelector("header.header")!;
    const svg = header.querySelector("svg.rtr-logo")!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    // Placed before the app name, which is the accessible label.
    const h1 = header.querySelector("h1")!;
    expect(h1.textContent).toBe("Redact-then-Reason");
    expect(svg.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    assertSafeSvg(svg);
    expect(document.querySelectorAll("#rtr-logo-grad").length).toBe(1); // unique gradient id

    const variant = THEMES[id].logo;
    expect(document.body.dataset.logo).toBe(variant);
    const grad = svg.querySelector(".rtr-logo__grad")!;
    const mono = svg.querySelector(".rtr-logo__mono")!;
    expect(getComputedStyle(grad).display === "none").toBe(variant === "mono");
    expect(getComputedStyle(mono).display === "none").toBe(variant === "gradient");
    for (const p of Array.from(mono.querySelectorAll("path"))) {
      expect([p.getAttribute("fill"), p.getAttribute("stroke")]).toContain("currentColor");
    }
    expect(document.body.style.getPropertyValue("--logo-fg")).toBe(THEMES[id].tokens.logoFg);
    expect(themeCssVars(id)["--logo-fg"]).toBe(THEMES[id].tokens.logoFg);
  });

  it("the old Chill mascot is gone (replaced by the logo)", () => {
    loadMarkup();
    expect(document.querySelector(".mascot")).toBeNull();
    expect(document.querySelectorAll("svg.rtr-logo").length).toBe(1);
  });

  it("inline gradient stops match LOGO_GRADIENT and the logo.svg source geometry", () => {
    loadMarkup();
    const stops = Array.from(document.querySelectorAll("#rtr-logo-grad stop"), (s) => s.getAttribute("stop-color"));
    expect(stops).toEqual([LOGO_GRADIENT.from, LOGO_GRADIENT.to]);
    const src = readFileSync(join(LOGO_DIR, "logo.svg"), "utf8");
    for (const p of Array.from(document.querySelectorAll(".rtr-logo__grad path"))) {
      expect(src).toContain(`d="${p.getAttribute("d")}"`);
    }
  });
});

describe("SVG source hygiene", () => {
  it.each(["logo.svg", "logo-16.svg", "logo-mono.svg"])("%s", (name) => {
    const src = readFileSync(join(LOGO_DIR, name), "utf8");
    expect(src.replaceAll(`xmlns="${SVG_NS}"`, "")).not.toMatch(/http/);
    expect(src).not.toMatch(/<script|<image|foreignObject|href|data:|<metadata|<style|<text|xmlns:xlink/i);
    const doc = new DOMParser().parseFromString(src, "image/svg+xml");
    const svg = doc.documentElement;
    expect(svg.tagName.toLowerCase()).toBe("svg");
    if (name !== "logo-16.svg") expect(svg.getAttribute("viewBox")).toBe("0 0 128 128");
    if (name === "logo-mono.svg") {
      expect(src).not.toMatch(/Gradient|url\(/);
      expect(src).toMatch(/currentColor/);
    } else {
      expect(src.toLowerCase()).toContain(LOGO_GRADIENT.from);
      expect(src.toLowerCase()).toContain(LOGO_GRADIENT.to);
    }
  });
});

// ------------------------------------------------------------------------------ manifest icons
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(Array.from(buf.subarray(0, 8))).toEqual(PNG_SIG);
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function iconEntries(manifest: { icons: Record<string, string>; action: { default_icon: Record<string, string> } }): [string, string][] {
  return [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)];
}

describe("manifest icons", () => {
  const manifest = JSON.parse(readFileSync(join(PKG, "manifest.json"), "utf8"));

  it("declares 16/32/48/128 icons and 16/32/48 action icons", () => {
    expect(Object.keys(manifest.icons).sort((a, b) => +a - +b)).toEqual(["16", "32", "48", "128"]);
    expect(Object.keys(manifest.action.default_icon).sort((a, b) => +a - +b)).toEqual(["16", "32", "48"]);
  });

  it("every declared icon exists in source, is a PNG and matches its declared size", () => {
    for (const [size, path] of iconEntries(manifest)) {
      const file = join(PKG, path);
      expect(existsSync(file), path).toBe(true);
      expect(pngSize(readFileSync(file)), path).toEqual({ w: +size, h: +size });
    }
  });

  it("dist (if built) contains the same icons", () => {
    const dist = join(PKG, "dist");
    if (!existsSync(join(dist, "manifest.json"))) return; // not built yet: nothing to check
    const built = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
    for (const [size, path] of iconEntries(built)) {
      const file = join(dist, path);
      expect(existsSync(file), `dist/${path}`).toBe(true);
      expect(pngSize(readFileSync(file)), path).toEqual({ w: +size, h: +size });
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
function blend(top: string, base: string, alpha: number): [number, number, number] {
  const t = rgb(top);
  const b = rgb(base);
  return t.map((v, i) => v * alpha + b[i]! * (1 - alpha)) as [number, number, number];
}

describe("logo contrast (graphical object, WCAG 1.4.11 >= 3:1)", () => {
  it.each(THEME_IDS)("%s: logo vs header background (bg and bg2, worst stop)", (id) => {
    const t = THEMES[id].tokens;
    // Gradient themes: every stop must clear 3:1; logoFg records the lighter (worst) stop.
    const colours = THEMES[id].logo === "gradient" ? [LOGO_GRADIENT.from, LOGO_GRADIENT.to] : [t.logoFg];
    if (THEMES[id].logo === "gradient") expect(t.logoFg).toBe(LOGO_GRADIENT.to);
    const results: string[] = [];
    let worst = Infinity;
    for (const c of colours) {
      for (const surface of ["bg", "bg2"] as const) {
        const r = ratio(rgb(c), rgb(t[surface]));
        worst = Math.min(worst, r);
        if (r < 3) results.push(`${c}/${surface} ${r.toFixed(2)}`);
      }
    }
    expect(results).toEqual([]);
    console.info(`[contrast] ${id}: logo (${THEMES[id].logo}) worst ${worst.toFixed(2)}:1`);
  });

  it("midnight: mono logo stays >= 3:1 over its violet glow (45% over bg)", () => {
    const t = THEMES.midnight.tokens;
    expect(ratio(rgb(t.logoFg), blend("#a855f7", t.bg, 0.45))).toBeGreaterThanOrEqual(3);
  });
});
