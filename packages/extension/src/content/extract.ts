// Content-side text extraction (ARCHITECTURE 3.1). Injected ONLY on a user gesture via
// chrome.scripting.executeScript({ target: { tabId }, func: extractPageText, args }).
//
// extractPageText MUST stay self-contained: Chrome serializes it with toString() and runs it
// in the page, so it may not reference imports or module-scope values at runtime. Everything
// it needs is declared inside the function body or passed in `args`.
//
// The page is untrusted: we only read text (selection toString / text node values) and return
// plain strings. No HTML serialization, no eval, no page mutation (we work on a detached clone),
// no Firebase, no model calls, no storage.

export type CaptureMode = "selection" | "page";

export interface PageTextPayload {
  type: "PAGE_TEXT";
  text: string;
  url: string;
  title: string;
  mode: CaptureMode;
  truncated: boolean;
}

/** Cap on captured text (characters). */
export const MAX_CAPTURE_CHARS = 200_000;

export function extractPageText(mode: CaptureMode, maxChars: number): PageTextPayload {
  const DROP =
    'nav, footer, aside, header, script, style, noscript, template, svg, iframe, [hidden], [aria-hidden="true"]';
  const BLOCK = new Set([
    "ADDRESS", "ARTICLE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN",
    "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "UL",
  ]);

  function tidy(s: string): string {
    return s
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Structured text walk over a detached clone. innerText on a detached node has no layout
  // (Chrome returns textContent), so block boundaries are rebuilt from tag names instead.
  function textOf(root: Node): string {
    const out: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        out.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node as Element).tagName.toUpperCase();
      if (tag === "BR") {
        out.push("\n");
        return;
      }
      const block = BLOCK.has(tag);
      const cell = tag === "TD" || tag === "TH";
      if (block) out.push("\n");
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block) out.push("\n");
      else if (cell) out.push(" \t ");
    };
    walk(root);
    return out.join("");
  }

  let text = "";
  if (mode === "selection") {
    text = (window.getSelection()?.toString() ?? "").replace(/\r\n?/g, "\n").trim();
  } else {
    const body = document.body;
    const pick = (sel: string): Element | null => {
      const el = document.querySelector(sel);
      return el && (el.textContent ?? "").trim() ? el : null;
    };
    const root = pick("main") ?? pick("article") ?? pick('[role="main"]') ?? body;
    if (root) {
      const clone = root.cloneNode(true) as Element;
      clone.querySelectorAll(DROP).forEach((el) => el.remove());
      text = tidy(textOf(clone));
    }
  }

  let truncated = false;
  if (text.length > maxChars) {
    let cut = Math.max(0, maxChars);
    // Do not split a surrogate pair.
    const code = text.charCodeAt(cut);
    if (cut > 0 && code >= 0xdc00 && code <= 0xdfff) cut -= 1;
    text = text.slice(0, cut);
    truncated = true;
  }

  return {
    type: "PAGE_TEXT",
    text,
    url: String(location.href),
    title: String(document.title ?? ""),
    mode,
    truncated,
  };
}
