// Mask text with typed, stable placeholders (ARCHITECTURE 3.4 "Placeholder map").
// The map never crosses the network, never goes into a prompt, never gets logged.

import type { Detection, EntityType, PlaceholderEntry, PlaceholderMap } from "../types";

export interface MaskOptions {
  /** Document id for the map. Generated with crypto.randomUUID() when omitted. */
  docId?: string;
  /** Timestamp override (tests). Defaults to Date.now(). */
  createdAt?: number;
}

export interface MaskResult {
  masked: string;
  map: PlaceholderMap;
}

function dedupKey(type: EntityType, original: string): string {
  const norm = type === "EMAIL" ? original.toLowerCase() : original;
  return `${type}\u0000${norm}`;
}

/**
 * Replace each detection with `[TYPE_N]`. Numbering is per type in order of appearance;
 * identical originals of the same type reuse one token (emails compared lowercase).
 * Detections must be non-overlapping (run mergeDetections first).
 *
 * Known limitation: if the source already contains a literal token string such as
 * "[EMAIL_1]", unmask() will treat it as a placeholder.
 */
export function mask(text: string, detections: readonly Detection[], opts: MaskOptions = {}): MaskResult {
  const sorted = [...detections].sort((a, b) => a.start - b.start);
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

  const counters = new Map<EntityType, number>();
  const byKey = new Map<string, PlaceholderEntry>();
  const entries: PlaceholderEntry[] = [];
  const tokens: string[] = [];

  for (const d of sorted) {
    const original = text.slice(d.start, d.end);
    const key = dedupKey(d.type, original);
    let entry = byKey.get(key);
    if (!entry) {
      const n = (counters.get(d.type) ?? 0) + 1;
      counters.set(d.type, n);
      entry = { token: `[${d.type}_${n}]`, type: d.type, original, start: d.start, end: d.end };
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

  return {
    masked,
    map: {
      docId: opts.docId ?? globalThis.crypto.randomUUID(),
      createdAt: opts.createdAt ?? Date.now(),
      entries,
    },
  };
}
