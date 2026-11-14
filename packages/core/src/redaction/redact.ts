// Convenience pipeline: deterministic detectors -> merge -> mask.
// Day 3 will add on-device LLM spans before the merge step.

import type { Detection, TypeCount } from "../types";
import { detectDeterministic } from "./regex";
import { mergeDetections } from "./merge";
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
  const merged = mergeDetections(detectDeterministic(text));
  const { masked, map } = mask(text, merged, opts);
  return { masked, map, counts: countByType(merged) };
}
