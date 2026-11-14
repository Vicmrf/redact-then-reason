// Convenience pipeline: deterministic detectors -> merge -> mask.
// redactWithLlm adds verified on-device LLM spans before the merge step (Day 3).

import type { Detection, PlaceholderMap, TypeCount } from "../types";
import { detectDeterministic } from "./regex";
import { mergeDetections } from "./merge";
import { MIN_EXPAND_CHARS, expandToAllOccurrences, findOccurrences, nonSpaceLength } from "./occurrences";
import { extendMask, mask, type MaskOptions, type MaskResult } from "./mask";

export interface RedactResult extends MaskResult {
  /** Occurrences per type (not unique values). No raw values. */
  counts: TypeCount[];
}

export function countByType(detections: readonly Detection[]): TypeCount[] {
  const counts = new Map<Detection["type"], number>();
  for (const d of detections) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

export function redact(text: string, opts: MaskOptions = {}): RedactResult {
  return redactWithLlm(text, [], opts);
}

/**
 * Deterministic detectors + verified on-device LLM detections -> expand -> merge -> mask.
 * Each LLM entity is expanded to EVERY exact occurrence in `text` (expandToAllOccurrences),
 * so a name the model listed once is masked everywhere. mergeDetections keeps regex spans of
 * deterministic types authoritative and otherwise lets the longest span win; mask assigns
 * stable [TYPE_N] placeholders (identical originals share one token).
 * `llmDetections` must already be verified against `text` (verifyLlmSpans).
 */
export function redactWithLlm(
  text: string,
  llmDetections: readonly Detection[],
  opts: MaskOptions = {},
): RedactResult {
  const llm = expandToAllOccurrences(text, llmDetections);
  const merged = mergeDetections([...detectDeterministic(text), ...llm]);
  const { masked, map } = mask(text, merged, opts);
  return { masked, map, counts: countByType(merged) };
}

/**
 * Redacts an EXTRA text that travels with an already-redacted document (e.g. a draft
 * instruction) against that document's map: deterministic detectors + verified on-device LLM
 * detections for `text` (expanded to every occurrence) + every exact occurrence of an original
 * already in `baseMap` -> merge -> extendMask. Originals already in the map reuse their tokens;
 * new ones get fresh tokens. Returns the masked text and a NEW extended map (base not mutated).
 * `llmDetections` must already be verified against `text` (verifyLlmSpans).
 */
export function redactWithMap(
  text: string,
  llmDetections: readonly Detection[],
  baseMap: PlaceholderMap,
  opts: Pick<MaskOptions, "reservedTexts"> = {},
): RedactResult {
  const fromMap: Detection[] = [];
  for (const e of baseMap.entries) {
    if (typeof e.original !== "string" || nonSpaceLength(e.original) < MIN_EXPAND_CHARS) continue;
    for (const start of findOccurrences(text, e.original)) {
      fromMap.push({ type: e.type, start, end: start + e.original.length, text: e.original, source: "llm" });
    }
  }
  const llm = expandToAllOccurrences(text, llmDetections);
  const merged = mergeDetections([...detectDeterministic(text), ...llm, ...fromMap]);
  const { masked, map } = extendMask(text, merged, baseMap, opts);
  return { masked, map, counts: countByType(merged) };
}
