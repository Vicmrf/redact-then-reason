// Defense in depth before any cloud call (ARCHITECTURE 3.4 step 5, 4.3, 5): the outgoing payload
// must not still contain any original value from the document's PlaceholderMap. Pure and generic:
// results and errors carry only types and counts, never the originals.
import type { EntityType, PlaceholderMap, TypeCount } from "../types";
import { findOccurrences, nonSpaceLength } from "../redaction/occurrences";
import { ENTITY_TYPE_ORDER } from "./payload";
import { preflightCheck, type PreflightResult } from "./preflight";
import { isEntityPassComplete, toEntityPassStatus, type EntityPassStatus } from "./entityPass";

/** Originals with fewer non-space characters than this are not checked (see findMapLeaks). */
export const MIN_LEAK_CHARS = 2;

/**
 * Comparison copy for the leak check ONLY (never for the payload itself, which must stay
 * byte-identical to the preview): Unicode NFKC, case-folded, every whitespace run (including
 * newlines and NBSP) collapsed to one space, trimmed.
 */
export function normalizeForLeakCheck(s: string): string {
  return s.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Counts, by type, the map entries whose original still appears in `payload`.
 *
 * Matching is deliberately MORE conservative than masking (masking stays exact and
 * case-sensitive): both sides are compared as normalizeForLeakCheck copies, so "JANE DOE",
 * "Jane\nDoe", "Jane  Doe" and NFKC-equivalent forms of "Jane Doe" all count. Because masking is
 * case-sensitive, such a variant left in the payload BLOCKS Send (fail closed, intended).
 *
 * Product-policy choices (owner review):
 * - Word boundaries are kept (findOccurrences), so map original "Ann" does not block "Annual".
 * - Originals with fewer than MIN_LEAK_CHARS non-space characters (one-character "names") are
 *   skipped: a single letter would block nearly every payload.
 *
 * Each entry counts at most once. Never returns the originals.
 */
export function findMapLeaks(payload: string, map: PlaceholderMap): TypeCount[] {
  const counts = new Map<EntityType, number>();
  const normPayload = normalizeForLeakCheck(payload);
  for (const e of map.entries) {
    if (typeof e.original !== "string" || nonSpaceLength(e.original) < MIN_LEAK_CHARS) continue;
    const original = normalizeForLeakCheck(e.original);
    if (original.length === 0) continue;
    if (findOccurrences(normPayload, original).length > 0) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return ENTITY_TYPE_ORDER.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
}

export class MapLeakError extends Error {
  readonly hits: TypeCount[];
  constructor(hits: TypeCount[]) {
    super(
      `Leak check blocked: payload still contains ${hits.map((h) => `${h.count} ${h.type}`).join(", ")} original value(s) from the placeholder map (compared ignoring case, spacing and Unicode form). Nothing was sent.`,
    );
    this.name = "MapLeakError";
    this.hits = hits;
  }
}

/** Throws MapLeakError if any map original still appears in the payload. */
export function assertNoMapLeaks(payload: string, map: PlaceholderMap): void {
  const hits = findMapLeaks(payload, map);
  if (hits.length > 0) throw new MapLeakError(hits);
}

/** Stable reason codes for a refused cloud send. */
export type CloudSendBlockReason = "preflight" | "map_leak" | "entity_pass_incomplete";

export interface CloudSendCheck {
  /** True only when pre-flight passes AND no map original remains AND the entity pass completed. */
  ok: boolean;
  preflight: PreflightResult;
  leaks: TypeCount[];
  /** Normalized entity-pass status (unknown / missing -> "pending"). */
  entityPass: EntityPassStatus;
  /** Empty when ok. */
  reasons: CloudSendBlockReason[];
}

/**
 * Pure consent-gate decision for one exact payload: Send may be enabled only if `ok`.
 * Re-runs pre-flight on the given string (not a cached result). Fails closed: any entity-pass
 * status other than "complete" (including undefined) blocks.
 */
export function checkCloudSend(
  payload: string,
  map: PlaceholderMap,
  entityPass: EntityPassStatus | undefined,
): CloudSendCheck {
  const preflight = preflightCheck(payload);
  const leaks = findMapLeaks(payload, map);
  const reasons: CloudSendBlockReason[] = [];
  if (!isEntityPassComplete(entityPass)) reasons.push("entity_pass_incomplete");
  if (!preflight.ok) reasons.push("preflight");
  if (leaks.length > 0) reasons.push("map_leak");
  return { ok: reasons.length === 0, preflight, leaks, entityPass: toEntityPassStatus(entityPass), reasons };
}
