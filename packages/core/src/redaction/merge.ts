// Overlap merge (TECH-SPEC 6): sort by start, longest wins on overlap, and a regex span
// of a deterministic type always beats an overlapping LLM span (an LLM OTHER must not
// hide an EMAIL).

import type { Detection, EntityType } from "../types";

export const DETERMINISTIC_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "EMAIL", "PHONE", "SSN", "CREDIT_CARD", "DOB", "DATE", "ACCOUNT", "IP", "MRN",
]);

function isAuthoritative(d: Detection): boolean {
  return d.source === "regex" && DETERMINISTIC_TYPES.has(d.type);
}

function rank(list: readonly Detection[]): Detection[] {
  // Priority: authoritative regex first, then longest, then earliest, then regex over llm.
  return [...list].sort((a, b) => {
    const auth = Number(isAuthoritative(b)) - Number(isAuthoritative(a));
    if (auth !== 0) return auth;
    const len = (b.end - b.start) - (a.end - a.start);
    if (len !== 0) return len;
    if (a.start !== b.start) return a.start - b.start;
    return Number(b.source === "regex") - Number(a.source === "regex");
  });
}

const EDGE_TRIM = /[\s\p{P}]/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Parts of a discarded LLM span not covered by any kept span, trimmed of whitespace/punctuation
 * at both ends; parts without a letter or digit are dropped. Same type and source as `d`.
 */
function residuals(d: Detection, kept: readonly Detection[]): Detection[] {
  let parts: Array<[number, number]> = [[d.start, d.end]];
  for (const k of kept) {
    if (!(k.start < d.end && d.start < k.end)) continue;
    parts = parts.flatMap(([s, e]): Array<[number, number]> => {
      if (k.end <= s || k.start >= e) return [[s, e]];
      const out: Array<[number, number]> = [];
      if (k.start > s) out.push([s, k.start]);
      if (k.end < e) out.push([k.end, e]);
      return out;
    });
  }
  const out: Detection[] = [];
  if (typeof d.text !== "string" || d.text.length !== d.end - d.start) {
    // Cannot see the characters: keep the uncovered parts untrimmed (over-mask, never under-mask).
    return parts.map(([s, e]) => ({ type: d.type, start: s, end: e, text: "", source: d.source }));
  }
  for (let [s, e] of parts) {
    while (s < e && EDGE_TRIM.test(d.text[s - d.start] ?? "")) s++;
    while (e > s && EDGE_TRIM.test(d.text[e - 1 - d.start] ?? "")) e--;
    const text = d.text.slice(s - d.start, e - d.start);
    if (e > s && HAS_WORD_CHAR.test(text)) out.push({ type: d.type, start: s, end: e, text, source: d.source });
  }
  return out;
}

/** Bound on residual rounds (each round only shrinks spans; this is a safety stop). */
const MAX_RESIDUAL_ROUNDS = 8;

/**
 * Returns non-overlapping detections sorted by start. Input is not mutated.
 *
 * TECH-SPEC 6 rule is unchanged: authoritative regex spans win, otherwise the longest span wins.
 * Additionally, a verified LLM span that loses an overlap is not thrown away whole: its parts
 * NOT covered by the winning span(s) are kept as the LLM type (e.g. an ADDRESS that contains an
 * EMAIL: the email is masked as EMAIL and the street part as ADDRESS), so identifying text the
 * model found is never left visible just because a smaller deterministic span overlapped it.
 * Residual trimming reads `text` (=== source.slice(start, end) for verified detections).
 */
export function mergeDetections(detections: readonly Detection[]): Detection[] {
  const valid = detections.filter((d) => Number.isInteger(d.start) && Number.isInteger(d.end) && d.start >= 0 && d.end > d.start);
  const kept: Detection[] = [];
  let work: Detection[] = valid;
  for (let round = 0; work.length > 0 && round < MAX_RESIDUAL_ROUNDS; round++) {
    const discardedLlm: Detection[] = [];
    for (const d of rank(work)) {
      if (!kept.some((k) => d.start < k.end && k.start < d.end)) kept.push(d);
      else if (d.source === "llm") discardedLlm.push(d);
    }
    work = discardedLlm.flatMap((d) => residuals(d, kept));
  }
  return kept.sort((a, b) => a.start - b.start);
}
