// Every-occurrence expansion (ARCHITECTURE 3.4: identical originals of the same type reuse one
// token, and 3.4 step 5 / 4.3: raw PII never leaves the device). The on-device LLM may list a
// name once while the document mentions it several times; masking only the listed span would
// leave the later mentions in the cloud payload. Generic and pure: no UI copy, no logging.
//
// No RegExp is ever built from document text: matching is indexOf loops plus char-class checks.

import type { Detection } from "../types";

/** Expansion skips texts with fewer than this many non-space characters. */
export const MIN_EXPAND_CHARS = 2;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Code point ending right before `index` (surrogate-pair aware). */
function charBefore(s: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = s.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = s.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(index - 2, index);
  }
  return s[index - 1];
}

/** Code point starting at `index` (surrogate-pair aware). */
function charAt(s: string, index: number): string | undefined {
  if (index >= s.length) return undefined;
  const cp = s.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** Non-space character count (code points). */
export function nonSpaceLength(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/u.test(ch)) n++;
  return n;
}

/**
 * Pure. Start offsets of every exact, case-sensitive occurrence of `needle` in `source`.
 * Word-boundary rule: if the needle starts with a letter/number (\p{L}\p{N}, plus combining
 * marks), the preceding character must not be one; likewise for the needle's last character
 * and the following character. So "Ann" never matches inside "Annual", and "Jane Doe" never
 * matches inside "Jane Doen". Occurrences may not overlap each other.
 */
export function findOccurrences(source: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  const first = charAt(needle, 0);
  const last = charBefore(needle, needle.length);
  const checkLeft = isWordChar(first);
  const checkRight = isWordChar(last);

  let from = 0;
  while (from <= source.length - needle.length) {
    const i = source.indexOf(needle, from);
    if (i < 0) break;
    const end = i + needle.length;
    const leftOk = !checkLeft || !isWordChar(charBefore(source, i));
    const rightOk = !checkRight || !isWordChar(charAt(source, end));
    if (leftOk && rightOk) {
      out.push(i);
      from = end;
    } else {
      from = i + 1;
    }
  }
  return out;
}

/**
 * Pure. Returns the input detections plus one detection for EVERY other exact occurrence of
 * each detection's text (same type, same source). Texts with fewer than MIN_EXPAND_CHARS
 * non-space characters are kept as given but not expanded. Output is not merged: run
 * mergeDetections next (overlaps resolve as before; mask then reuses one token per original).
 */
export function expandToAllOccurrences(source: string, detections: readonly Detection[]): Detection[] {
  const out: Detection[] = [...detections];
  const seenSpans = new Set(detections.map((d) => `${d.start}:${d.end}:${d.type}`));
  const expanded = new Set<string>();

  for (const d of detections) {
    const text = d.text;
    if (typeof text !== "string" || nonSpaceLength(text) < MIN_EXPAND_CHARS) continue;
    const key = `${d.type}\u0000${d.source}\u0000${text}`;
    if (expanded.has(key)) continue;
    expanded.add(key);

    for (const start of findOccurrences(source, text)) {
      const end = start + text.length;
      const spanKey = `${start}:${end}:${d.type}`;
      if (seenSpans.has(spanKey)) continue;
      seenSpans.add(spanKey);
      out.push({ type: d.type, start, end, text, source: d.source });
    }
  }
  return out;
}
