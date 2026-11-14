// Mask text with typed, stable placeholders (ARCHITECTURE 3.4 "Placeholder map").
// The map never crosses the network, never goes into a prompt, never gets logged.

import type { Detection, EntityType, PlaceholderEntry, PlaceholderMap } from "../types";

export interface MaskOptions {
  /** Document id for the map. Generated with crypto.randomUUID() when omitted. */
  docId?: string;
  /** Timestamp override (tests). Defaults to Date.now(). */
  createdAt?: number;
  /**
   * Other texts that will travel with this masked text (e.g. a draft instruction). Any literal
   * token-looking string in them (like "[PERSON_1]") is never assigned as a new token.
   */
  reservedTexts?: readonly string[];
}

export interface MaskResult {
  masked: string;
  map: PlaceholderMap;
}

function dedupKey(type: EntityType, original: string): string {
  const norm = type === "EMAIL" ? original.toLowerCase() : original;
  return `${type}\u0000${norm}`;
}

/** Same shape as the tokens mask() emits: "[" TYPE ("_" WORD)* "_" N "]". */
const TOKEN_LIKE_RE = /\[[A-Z]+(?:_[A-Z]+)*_\d+\]/g;

/** Every literal token-looking string in `texts` (pure). */
export function literalTokens(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(TOKEN_LIKE_RE)) out.add(m[0]);
  return out;
}

function assertMaskable(text: string, sorted: readonly Detection[]): void {
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i]!;
    if (d.start < 0 || d.end > text.length || d.end <= d.start) {
      throw new RangeError("mask: detection span is out of bounds");
    }
    const prev = sorted[i - 1];
    if (prev && d.start < prev.end) {
      throw new Error("mask: overlapping detections; run mergeDetections first");
    }
  }
}

/**
 * Shared core of mask / extendMask. `base` entries are reused when the same (type, original)
 * appears again; new tokens continue after the highest number already used for that type and
 * skip every `reserved` token string, so a token in the map can never also occur literally in
 * the source (Codex 11: a literal "[PERSON_1]" in the document stays literal after unmask).
 */
function maskInto(
  text: string,
  detections: readonly Detection[],
  base: readonly PlaceholderEntry[],
  reserved: ReadonlySet<string>,
): { masked: string; entries: PlaceholderEntry[] } {
  const sorted = [...detections].sort((a, b) => a.start - b.start);
  assertMaskable(text, sorted);

  const counters = new Map<EntityType, number>();
  const byKey = new Map<string, PlaceholderEntry>();
  const entries: PlaceholderEntry[] = [...base];
  const taken = new Set<string>(reserved);
  for (const e of base) {
    byKey.set(dedupKey(e.type, e.original), e);
    taken.add(e.token);
    const n = Number(/_(\d+)\]$/.exec(e.token)?.[1] ?? 0);
    if (n > (counters.get(e.type) ?? 0)) counters.set(e.type, n);
  }
  const tokens: string[] = [];

  for (const d of sorted) {
    const original = text.slice(d.start, d.end);
    const key = dedupKey(d.type, original);
    let entry = byKey.get(key);
    if (!entry) {
      let n = (counters.get(d.type) ?? 0) + 1;
      while (taken.has(`[${d.type}_${n}]`)) n++;
      counters.set(d.type, n);
      entry = { token: `[${d.type}_${n}]`, type: d.type, original, start: d.start, end: d.end };
      taken.add(entry.token);
      byKey.set(key, entry);
      entries.push(entry);
    }
    tokens.push(entry.token);
  }

  // Apply from end to start so earlier offsets stay valid.
  let masked = text;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i]!;
    masked = masked.slice(0, d.start) + tokens[i]! + masked.slice(d.end);
  }
  return { masked, entries };
}

/**
 * Masks an additional text (e.g. a draft instruction) against an EXISTING map: an original that
 * is already in `base` (same type; emails compared lowercase) reuses its token; anything new gets
 * a fresh token number that is not used by `base` and not present literally in `text` or
 * `opts.reservedTexts`. Returns a NEW map (base entries first, then the new ones; new entries'
 * start/end are offsets into `text`). `base` is not mutated.
 */
export function extendMask(
  text: string,
  detections: readonly Detection[],
  base: PlaceholderMap,
  opts: Pick<MaskOptions, "reservedTexts"> = {},
): MaskResult {
  const reserved = literalTokens([text, ...(opts.reservedTexts ?? [])]);
  const { masked, entries } = maskInto(text, detections, base.entries, reserved);
  return { masked, map: { docId: base.docId, createdAt: base.createdAt, entries } };
}

/**
 * Replace each detection with `[TYPE_N]`. Numbering is per type in order of appearance;
 * identical originals of the same type reuse one token (emails compared lowercase).
 * Detections must be non-overlapping (run mergeDetections first).
 *
 * Token numbers that already occur literally in `text` (or in opts.reservedTexts) are skipped,
 * so unmask() never turns a literal "[EMAIL_1]" from the source into someone's address.
 */
export function mask(text: string, detections: readonly Detection[], opts: MaskOptions = {}): MaskResult {
  const reserved = literalTokens([text, ...(opts.reservedTexts ?? [])]);
  const { masked, entries } = maskInto(text, detections, [], reserved);
  return {
    masked,
    map: {
      docId: opts.docId ?? globalThis.crypto.randomUUID(),
      createdAt: opts.createdAt ?? Date.now(),
      entries,
    },
  };
}

