// Convenience pipeline: deterministic detectors -> merge -> mask.
// redactWithLlm adds verified on-device LLM spans before the merge step (Day 3).

import type { Detection, TypeCount } from "../types";
import { detectDeterministic } from "./regex";
import { mergeDetections } from "./merge";
import { expandToAllOccurrences } from "./occurrences";
import { mask, type MaskOptions, type MaskResult } from "./mask";

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
