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

/** Returns non-overlapping detections sorted by start. Input is not mutated. */
export function mergeDetections(detections: readonly Detection[]): Detection[] {
  const valid = detections.filter((d) => Number.isInteger(d.start) && Number.isInteger(d.end) && d.start >= 0 && d.end > d.start);
  // Priority: authoritative regex first, then longest, then earliest, then regex over llm.
  const ranked = [...valid].sort((a, b) => {
    const auth = Number(isAuthoritative(b)) - Number(isAuthoritative(a));
    if (auth !== 0) return auth;
    const len = (b.end - b.start) - (a.end - a.start);
    if (len !== 0) return len;
    if (a.start !== b.start) return a.start - b.start;
    return Number(b.source === "regex") - Number(a.source === "regex");
  });
  const kept: Detection[] = [];
  for (const d of ranked) {
    if (!kept.some((k) => d.start < k.end && k.start < d.end)) kept.push(d);
  }
  return kept.sort((a, b) => a.start - b.start);
}
