// Defense in depth before any cloud call (ARCHITECTURE 3.4 step 5, 4.3, 5): the outgoing payload
// must not still contain any original value from the document's PlaceholderMap. Pure and generic:
// results and errors carry only types and counts, never the originals.
import type { EntityType, PlaceholderMap, TypeCount } from "../types";
import { findOccurrences } from "../redaction/occurrences";
import { ENTITY_TYPE_ORDER } from "./payload";
import { preflightCheck, type PreflightResult } from "./preflight";
import { isEntityPassComplete, toEntityPassStatus, type EntityPassStatus } from "./entityPass";

/** Originals shorter than this (after trim) are not checked. */
export const MIN_LEAK_CHARS = 2;

/**
 * Counts, by type, the map entries whose trimmed `original` (length >= MIN_LEAK_CHARS) still
 * appears verbatim in `payload`. Same boundary rule as the masking expansion (findOccurrences),
 * so "Ann" does not count inside "Annual"; EMAIL is compared case-insensitively. Each entry
 * counts at most once. Never returns the originals.
 */
export function findMapLeaks(payload: string, map: PlaceholderMap): TypeCount[] {
  const counts = new Map<EntityType, number>();
  const lowerPayload = payload.toLowerCase();
  for (const e of map.entries) {
    const original = typeof e.original === "string" ? e.original.trim() : "";
    if (original.length < MIN_LEAK_CHARS) continue;
    const hit =
      e.type === "EMAIL"
        ? findOccurrences(lowerPayload, original.toLowerCase()).length > 0
        : findOccurrences(payload, original).length > 0;
    if (hit) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return ENTITY_TYPE_ORDER.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
}

export class MapLeakError extends Error {
  readonly hits: TypeCount[];
  constructor(hits: TypeCount[]) {
    super(
      `Leak check blocked: payload still contains ${hits.map((h) => `${h.count} ${h.type}`).join(", ")} original value(s) from the placeholder map. Nothing was sent.`,
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
