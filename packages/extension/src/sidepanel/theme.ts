// Side-panel themes (presentational only). Each theme is a token object; applyTheme() writes the
// tokens as CSS custom properties on the panel root and sets a `theme-<id>` class. Decorative
// extras (gradients, glows, scanlines, paper texture, fonts) live in styles.css under that class
// and only use these variables.
//
// Storage: chrome.storage.local holds ONLY the theme id under THEME_STORAGE_KEY. Never document
// text, maps or results.
//
// Copy / label variants never change meaning or behaviour: the Chill status variant swaps only
// the exact NOTHING_LEFT string; Terminal button labels change text only (same buttons, ids and
// handlers) and keep the plain label as the accessible name.
import { NOTHING_LEFT } from "../lib/consentCopy";

export const THEME_IDS = ["calm", "chill", "midnight", "terminal", "paper"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "calm";
export const THEME_STORAGE_KEY = "rtr-theme";

/** Chip colour families; every placeholder type maps to one (see CHIP_FAMILY_BY_TYPE). */
export const CHIP_FAMILIES = ["person", "contact", "id", "org", "date", "other"] as const;
export type ChipFamily = (typeof CHIP_FAMILIES)[number];

export interface ColorPair {
  fg: string;
  bg: string;
}

export interface ThemeTokens {
  colorScheme: "light" | "dark";
  /** Body text and the panel background. bg2 is the second gradient / texture stop (worst case). */
  fg: string;
  bg: string;
  bg2: string;
  card: string;
  border: string;
  mutedFg: string;
  /** Focus ring and glow colour. */
  accent: string;
  linkFg: string;
  primaryBg: string;
  primaryFg: string;
  /** Visible boundary of the primary button against the card. */
  primaryBorder: string;
  inputBg: string;
  disabledFg: string;
  disabledBg: string;
  badgeFg: string;
  badgeBg: string;
  deviceFg: string;
  deviceBg: string;
  cloudFg: string;
  cloudBg: string;
  errorFg: string;
  errorBg: string;
  okFg: string;
  okBg: string;
  statusFg: string;
  statusBg: string;
  chips: Record<ChipFamily, ColorPair>;
  /** Opacity of the black scanline overlay (Terminal only; 0 elsewhere). */
  scanlineAlpha: number;
}

/** Buttons whose visible label may vary per theme (text only; same element, id and handler). */
export const LABEL_IDS = ["redact-btn", "explain-btn", "draft-btn", "explain-cloud-btn", "draft-cloud-btn"] as const;
export type LabelId = (typeof LABEL_IDS)[number];

export interface ThemeDef {
  id: ThemeId;
  name: string;
  tokens: ThemeTokens;
  labels?: Partial<Record<LabelId, string>>;
  /** Replacement for the exact NOTHING_LEFT status string (same meaning). */
  nothingLeft?: string;
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  calm: {
    id: "calm",
    name: "Calm",
    tokens: {
      colorScheme: "light",
      fg: "#0f172a",
      bg: "#f8fafc",
      bg2: "#f1f5f9",
      card: "#ffffff",
      border: "#cbd5e1",
      mutedFg: "#475569",
      accent: "#2563eb",
      linkFg: "#1d4ed8",
      primaryBg: "#2563eb",
      primaryFg: "#ffffff",
      primaryBorder: "#2563eb",
      inputBg: "#ffffff",
      disabledFg: "#475569",
      disabledBg: "#e2e8f0",
      badgeFg: "#334155",
      badgeBg: "#e2e8f0",
      deviceFg: "#065f46",
      deviceBg: "#d1fae5",
      cloudFg: "#1e3a8a",
      cloudBg: "#dbeafe",
      errorFg: "#991b1b",
      errorBg: "#fee2e2",
      okFg: "#065f46",
      okBg: "#ecfdf5",
      statusFg: "#334155",
      statusBg: "#f1f5f9",
      chips: {
        person: { fg: "#1e40af", bg: "#dbeafe" },
        contact: { fg: "#6b21a8", bg: "#f3e8ff" },
        id: { fg: "#9f1239", bg: "#ffe4e6" },
        org: { fg: "#155e75", bg: "#cffafe" },
        date: { fg: "#854d0e", bg: "#fef9c3" },
        other: { fg: "#374151", bg: "#e5e7eb" },
      },
      scanlineAlpha: 0,
    },
  },
  chill: {
    id: "chill",
    name: "Chill",
    nothingLeft: "Nothing left your device ✨",
    tokens: {
      colorScheme: "light",
      fg: "#2e1065",
      bg: "#ede9fe",
      bg2: "#d1fae5",
      card: "#fffbff",
      border: "#c4b5fd",
      mutedFg: "#5b21b6",
      accent: "#7c3aed",
      linkFg: "#6d28d9",
      primaryBg: "#6d28d9",
      primaryFg: "#ffffff",
      primaryBorder: "#6d28d9",
      inputBg: "#ffffff",
      disabledFg: "#5b21b6",
      disabledBg: "#ede9fe",
      badgeFg: "#4c1d95",
      badgeBg: "#f5f3ff",
      deviceFg: "#065f46",
      deviceBg: "#bbf7d0",
      cloudFg: "#1e3a8a",
      cloudBg: "#bfdbfe",
      errorFg: "#9f1239",
      errorBg: "#ffe4e6",
      okFg: "#065f46",
      okBg: "#dcfce7",
      statusFg: "#4c1d95",
      statusBg: "#faf5ff",
      chips: {
        person: { fg: "#9d174d", bg: "#fce7f3" },
        contact: { fg: "#5b21b6", bg: "#ede9fe" },
        id: { fg: "#9a3412", bg: "#ffedd5" },
        org: { fg: "#0f766e", bg: "#ccfbf1" },
        date: { fg: "#854d0e", bg: "#fef08a" },
        other: { fg: "#3730a3", bg: "#e0e7ff" },
      },
      scanlineAlpha: 0,
    },
  },
  midnight: {
    id: "midnight",
    name: "Midnight",
    tokens: {
      colorScheme: "dark",
      fg: "#e6edf7",
      bg: "#0b0d12",
      bg2: "#111827",
      card: "#151a24",
      border: "#2a3346",
      mutedFg: "#a3b1c6",
      accent: "#22d3ee",
      linkFg: "#67e8f9",
      primaryBg: "#1d4ed8",
      primaryFg: "#ffffff",
      primaryBorder: "#22d3ee",
      inputBg: "#0b0d12",
      disabledFg: "#94a3b8",
      disabledBg: "#1f2633",
      badgeFg: "#cbd5e1",
      badgeBg: "#1f2633",
      deviceFg: "#a7f3d0",
      deviceBg: "#064e3b",
      cloudFg: "#c7d2fe",
      cloudBg: "#312e81",
      errorFg: "#fecaca",
      errorBg: "#7f1d1d",
      okFg: "#a7f3d0",
      okBg: "#064e3b",
      statusFg: "#c7d2fe",
      statusBg: "#10141c",
      chips: {
        person: { fg: "#67e8f9", bg: "#083344" },
        contact: { fg: "#e9d5ff", bg: "#4c1d95" },
        id: { fg: "#fda4af", bg: "#4c0519" },
        org: { fg: "#5eead4", bg: "#042f2e" },
        date: { fg: "#fde68a", bg: "#422006" },
        other: { fg: "#e2e8f0", bg: "#1e293b" },
      },
      scanlineAlpha: 0,
    },
  },
  terminal: {
    id: "terminal",
    name: "Terminal",
    labels: {
      "redact-btn": "$ redact",
      "explain-btn": "$ explain --on-device",
      "draft-btn": "$ draft --on-device",
      "explain-cloud-btn": "$ cloud --deeper explain",
      "draft-cloud-btn": "$ cloud --deeper draft",
    },
    tokens: {
      colorScheme: "dark",
      fg: "#4ade80",
      bg: "#050805",
      bg2: "#050805",
      card: "#0a110a",
      border: "#1f4d1f",
      mutedFg: "#fbbf24",
      accent: "#fbbf24",
      linkFg: "#fbbf24",
      primaryBg: "#14532d",
      primaryFg: "#bbf7d0",
      primaryBorder: "#4ade80",
      inputBg: "#000000",
      disabledFg: "#8fae8f",
      disabledBg: "#0f1a0f",
      badgeFg: "#4ade80",
      badgeBg: "#0f1a0f",
      deviceFg: "#050805",
      deviceBg: "#4ade80",
      cloudFg: "#050805",
      cloudBg: "#fbbf24",
      errorFg: "#fca5a5",
      errorBg: "#2a0a0a",
      okFg: "#4ade80",
      okBg: "#0f1a0f",
      statusFg: "#fbbf24",
      statusBg: "#0a110a",
      chips: {
        person: { fg: "#4ade80", bg: "#0f2a14" },
        contact: { fg: "#fbbf24", bg: "#2a1f05" },
        id: { fg: "#f87171", bg: "#2a0a0a" },
        org: { fg: "#67e8f9", bg: "#062a30" },
        date: { fg: "#fde68a", bg: "#2a2405" },
        other: { fg: "#d1d5db", bg: "#1a1a1a" },
      },
      scanlineAlpha: 0.15,
    },
  },
  paper: {
    id: "paper",
    name: "Paper",
    tokens: {
      colorScheme: "light",
      fg: "#2b2118",
      bg: "#f6efe0",
      bg2: "#ede3cf",
      card: "#fbf7ee",
      border: "#d6c7a8",
      mutedFg: "#5c4a38",
      accent: "#9a3b22",
      linkFg: "#8a3520",
      primaryBg: "#4f6b52",
      primaryFg: "#ffffff",
      primaryBorder: "#4f6b52",
      inputBg: "#fffdf7",
      disabledFg: "#6b5a48",
      disabledBg: "#e9e0cc",
      badgeFg: "#3f3226",
      badgeBg: "#ece2cc",
      deviceFg: "#2f4a33",
      deviceBg: "#dfe9d8",
      cloudFg: "#7a2e1a",
      cloudBg: "#f6dfd3",
      errorFg: "#8b1e12",
      errorBg: "#f8dcd3",
      okFg: "#2f4a33",
      okBg: "#e3ecdc",
      statusFg: "#3f3226",
      statusBg: "#f1e8d6",
      chips: {
        person: { fg: "#7a2e1a", bg: "#f6dfd3" },
        contact: { fg: "#2f4a33", bg: "#dde8d5" },
        id: { fg: "#6b2142", bg: "#f2dbe3" },
        org: { fg: "#1f4e5a", bg: "#d8e8ea" },
        date: { fg: "#6a4a0c", bg: "#f3e5bf" },
        other: { fg: "#3f3226", bg: "#e6dccb" },
      },
      scanlineAlpha: 0,
    },
  },
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

function kebab(key: string): string {
  return key.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);
}

/** CSS custom properties for a theme (name -> value). styles.css :root mirrors calm's set. */
export function themeCssVars(id: ThemeId): Record<string, string> {
  const t = THEMES[id].tokens;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(t)) {
    if (key === "chips" || key === "colorScheme" || key === "scanlineAlpha") continue;
    out[`--${kebab(key)}`] = value as string;
  }
  for (const fam of CHIP_FAMILIES) {
    out[`--chip-${fam}-fg`] = t.chips[fam].fg;
    out[`--chip-${fam}-bg`] = t.chips[fam].bg;
  }
  out["--scanline-alpha"] = String(t.scanlineAlpha);
  return out;
}

let current: ThemeId = DEFAULT_THEME;

export function currentTheme(): ThemeId {
  return current;
}

/** Sets the label variant for one button: visible text changes, the accessible name stays plain. */
function applyLabel(doc: Document, id: LabelId, theme: ThemeDef): void {
  const btn = doc.getElementById(id);
  if (!btn) return;
  if (btn.dataset.plainLabel === undefined) btn.dataset.plainLabel = btn.textContent ?? "";
  const plain = btn.dataset.plainLabel;
  const variant = theme.labels?.[id];
  btn.textContent = variant ?? plain;
  if (variant !== undefined) btn.setAttribute("aria-label", btn.dataset.ariaPlain ?? plain);
  else if (btn.dataset.ariaPlain !== undefined) btn.setAttribute("aria-label", btn.dataset.ariaPlain);
  else btn.removeAttribute("aria-label");
}

/**
 * Applies a theme to `root` (default: document.body): `theme-<id>` class, CSS variables,
 * color-scheme, and per-theme button labels. Invalid ids fall back to the default theme.
 */
export function applyTheme(id: string, root: HTMLElement = document.body): ThemeId {
  const theme = THEMES[isThemeId(id) ? id : DEFAULT_THEME];
  for (const t of THEME_IDS) root.classList.remove(`theme-${t}`);
  root.classList.add(`theme-${theme.id}`);
  for (const [name, value] of Object.entries(themeCssVars(theme.id))) root.style.setProperty(name, value);
  root.style.colorScheme = theme.tokens.colorScheme;
  // Buttons that carry their own descriptive aria-label keep it as the plain accessible name.
  for (const labelId of LABEL_IDS) {
    const btn = root.ownerDocument.getElementById(labelId);
    // Captured once, before any theme has touched the button.
    if (btn && btn.dataset.plainLabel === undefined && btn.hasAttribute("aria-label")) {
      btn.dataset.ariaPlain = btn.getAttribute("aria-label") ?? "";
    }
    applyLabel(root.ownerDocument, labelId, theme);
  }
  current = theme.id;
  return theme.id;
}

function localStore(): chrome.storage.LocalStorageArea | null {
  try {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

/** Stored theme id, or the default when missing, invalid or storage is unavailable. */
export async function loadTheme(): Promise<ThemeId> {
  const store = localStore();
  if (!store) return DEFAULT_THEME;
  try {
    const got = await store.get(THEME_STORAGE_KEY);
    const value: unknown = got?.[THEME_STORAGE_KEY];
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persists ONLY the theme id. */
export async function saveTheme(id: ThemeId): Promise<void> {
  if (!isThemeId(id)) return;
  const store = localStore();
  if (!store) return;
  try {
    await store.set({ [THEME_STORAGE_KEY]: id });
  } catch {
    // Non-fatal: the theme simply is not remembered.
  }
}

/**
 * Presentational mapping of a privacy/status line for the theme. Only the exact NOTHING_LEFT
 * string may be swapped (same meaning); every other line is returned verbatim.
 */
export function privacyCopy(line: string, id: ThemeId = current): string {
  const variant = THEMES[id]?.nothingLeft;
  return line === NOTHING_LEFT && variant ? variant : line;
}

/**
 * Fills the picker, restores the stored theme, and saves + applies on change.
 * `onApplied` runs after every apply (e.g. to re-render the status line copy).
 */
export async function initThemePicker(
  select: HTMLSelectElement,
  root: HTMLElement = document.body,
  onApplied: (id: ThemeId) => void = () => {},
): Promise<ThemeId> {
  if (select.options.length === 0) {
    for (const id of THEME_IDS) {
      const opt = select.ownerDocument.createElement("option");
      opt.value = id;
      opt.textContent = THEMES[id].name;
      select.append(opt);
    }
  }
  let userChose = false;
  select.addEventListener("change", () => {
    userChose = true;
    const id = applyTheme(select.value, root);
    select.value = id;
    onApplied(id);
    void saveTheme(id);
  });
  const stored = await loadTheme();
  if (userChose) return current; // a pick made while storage was loading wins
  const id = applyTheme(stored, root);
  select.value = id;
  onApplied(id);
  return id;
}
