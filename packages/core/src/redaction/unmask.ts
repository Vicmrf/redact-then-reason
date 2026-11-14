// Unmask model output locally (ARCHITECTURE 3.4 "Unmasking").
// 1. Replace only exact tokens from the map. No regex built from user text and no
//    String.replace(), so "$1" / "$&" / regex metacharacters in originals stay literal.
// 2. Scan the result with the email / SSN / Luhn detectors. Any hit that is not wholly
//    inside a span we just substituted from the map is possible model-invented or leaked
//    PII: it is replaced with [REDACTED_SUSPECT] and counted.

import type { PlaceholderEntry, PlaceholderMap } from "../types";
import { detectHighRisk } from "./regex";

export const SUSPECT_TOKEN = "[REDACTED_SUSPECT]";

export interface UnmaskResult {
  text: string;
  /** Number of suspect identifiers that were hidden. Show a warning when > 0. */
  suspects: number;
}

interface TokenHit {
  pos: number;
  entry: PlaceholderEntry;
}

export function unmask(output: string, map: PlaceholderMap): UnmaskResult {
  // Find every exact token occurrence with indexOf (plain string search).
  const hits: TokenHit[] = [];
  for (const entry of map.entries) {
    if (!entry.token) continue;
    let from = 0;
    for (;;) {
      const pos = output.indexOf(entry.token, from);
      if (pos < 0) break;
      hits.push({ pos, entry });
      from = pos + entry.token.length;
    }
  }
  hits.sort((a, b) => a.pos - b.pos || b.entry.token.length - a.entry.token.length);

  // Build the output in one pass, remembering where originals were substituted.
  let text = "";
  let cursor = 0;
  const substituted: Array<{ start: number; end: number }> = [];
  for (const h of hits) {
    if (h.pos < cursor) continue; // overlapping token occurrence; first one wins
    text += output.slice(cursor, h.pos);
    const start = text.length;
    text += h.entry.original;
    substituted.push({ start, end: text.length });
    cursor = h.pos + h.entry.token.length;
  }
  text += output.slice(cursor);

  // Post-scan for identifiers that did not come from the map.
  const suspects = detectHighRisk(text).filter(
    (d) => !substituted.some((s) => d.start >= s.start && d.end <= s.end),
  );
  for (let i = suspects.length - 1; i >= 0; i--) {
    const d = suspects[i]!;
    text = text.slice(0, d.start) + SUSPECT_TOKEN + text.slice(d.end);
  }

  return { text, suspects: suspects.length };
}
