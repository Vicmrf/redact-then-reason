// Pre-flight check on any payload about to leave the device (ARCHITECTURE 5, BUILD-PLAN Day 2):
// the payload must not still contain an email, SSN, card number (PAN, Luhn-valid) or phone.
// ARCHITECTURE 5 lists email / SSN / Luhn; PHONE is a deliberate, stricter addition.
// Results and errors carry only types and counts, never raw matched values.

import type { EntityType, TypeCount } from "../types";
import { detectDeterministic } from "../redaction/regex";

/** Types that hard-block a payload: any single hit refuses the send. */
export const PREFLIGHT_BLOCKING_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "EMAIL",
  "SSN",
  "CREDIT_CARD",
  "PHONE",
]);

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

/** Throws PreflightError if the payload still contains an EMAIL, SSN, CREDIT_CARD or PHONE. */
export function assertPreflight(payload: string): PreflightResult {
  const result = preflightCheck(payload);
  if (!result.ok) throw new PreflightError(result.hits);
  return result;
}
