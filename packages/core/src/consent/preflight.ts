// Pre-flight check on any payload about to leave the device (BUILD-PLAN Day 2):
// the payload must not still contain an email, SSN or card number (PAN).
// Results and errors carry only types and counts, never raw matched values.

import type { EntityType, TypeCount } from "../types";
import { detectDeterministic } from "../redaction/regex";

/** Types that hard-block a payload. Phones are reported but do not block. */
export const PREFLIGHT_BLOCKING_TYPES: ReadonlySet<EntityType> = new Set<EntityType>(["EMAIL", "SSN", "CREDIT_CARD"]);

export interface PreflightResult {
  ok: boolean;
  hits: TypeCount[];
}

export class PreflightError extends Error {
  readonly hits: TypeCount[];
  constructor(hits: TypeCount[]) {
    const blocking = hits.filter((h) => PREFLIGHT_BLOCKING_TYPES.has(h.type));
    super(
      `Pre-flight blocked: payload still contains ${blocking.map((h) => `${h.count} ${h.type}`).join(", ")}. Nothing was sent.`,
    );
    this.name = "PreflightError";
    this.hits = hits;
  }
}

export function preflightCheck(payload: string): PreflightResult {
  const counts = new Map<EntityType, number>();
  for (const d of detectDeterministic(payload)) {
    counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  }
  const hits = [...counts].map(([type, count]) => ({ type, count }));
  const ok = !hits.some((h) => PREFLIGHT_BLOCKING_TYPES.has(h.type));
  return { ok, hits };
}

/** Throws PreflightError if the payload still contains an EMAIL, SSN or CREDIT_CARD. */
export function assertPreflight(payload: string): PreflightResult {
  const result = preflightCheck(payload);
  if (!result.ok) throw new PreflightError(result.hits);
  return result;
}
