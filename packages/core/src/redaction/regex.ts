// Deterministic detectors (ARCHITECTURE 3.4 table, TECH-SPEC 6).
// These are the safety floor for well-structured identifiers. Never log matched values.
//
// TODO(Day 3+): DOB / DATE, ACCOUNT, IP, MRN detectors (ARCHITECTURE 3.4 table) are not implemented yet.

import type { Detection, EntityType } from "../types";
import { luhnOk } from "./luhn";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Candidate digit runs. Between digits: nothing, one dash, 1-4 spaces/tabs/NBSP, or one line break
// with optional spaces/tabs around it (a PAN copied across lines or table cells). The exact 13-19
// digit card is chosen afterwards by a window search over whole digit groups + Luhn, so offsets
// always start/end on digits.
// Boundaries: must not continue a longer digit run (preceding digit / "digit-"), and must not be
// followed by a digit or "_". A leading letter or "-" after a letter is allowed ("Card-4111...",
// "x4111..."): over-masking a glued PAN is safe, missing it is not.
const CARD_SEP = String.raw`(?:-|[ \t ]{1,4}|[ \t ]*\r?\n[ \t ]*)?`;
const CARD_CANDIDATE_RE = new RegExp(String.raw`(?<![\d_])(?<!\d-)\d(?:${CARD_SEP}\d){12,}(?![\d_])`, "g");

const SSN_DASHED_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
// "123 45 6789": single spaces, same validity rules as the dashed form, and not a fragment of a
// longer space/dash separated digit sequence.
const SSN_SPACED_RE = /(?<!\d[ -]?)\b(?!000|666|9\d{2})\d{3} (?!00)\d{2} (?!0000)\d{4}\b(?![ -]?\d)/g;
const SSN_BARE_RE = /\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g;
const SSN_KEYWORD_RE = /\b(?:ssn|social\s+security|itin|tin)\b/i;
const SSN_KEYWORD_BEFORE = 40;
const SSN_KEYWORD_AFTER = 20;

// Optional "+CC " (or a bare NANP "1-"), then groups of 2-4 digits (first may be parenthesized) joined by
// a single space, dot or dash. Post-filtered (ARCHITECTURE 3.4 table): international "+..." numbers
// 8-15 digits in total (country code included); everything else (NANP etc.) 10-15 digits.
const PHONE_RE = /(?<![\w+./-])(?:\+\d{1,3}[ .-]?|1[ .-])?(?:\(\d{2,4}\)|\d{2,4})(?:[ .-]?\d{2,4}){1,5}(?!\w)/g;
const PHONE_MIN_DIGITS = 10;
const PHONE_INTL_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;

function digitCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

function make(type: EntityType, text: string, start: number, end: number): Detection {
  return { type, start, end, text: text.slice(start, end), source: "regex" };
}

function overlapsAny(start: number, end: number, taken: readonly Detection[]): boolean {
  return taken.some((d) => start < d.end && d.start < end);
}

export function detectEmails(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index;
    out.push(make("EMAIL", text, start, start + m[0].length));
  }
  return out;
}

interface DigitGroup {
  start: number;
  end: number;
  digits: string;
  line: number;
}

/**
 * Window search over groups[from..to] (inclusive): from each start group, take the longest run of
 * whole groups that is 13-19 digits and passes Luhn. Returns [first, last] group index pairs.
 */
function luhnWindows(groups: readonly DigitGroup[], from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = from;
  while (i <= to) {
    let found = -1;
    for (let j = to; j >= i; j--) {
      let digits = "";
      for (let k = i; k <= j; k++) digits += groups[k]!.digits;
      if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      out.push([i, found]);
      i = found + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Runs of consecutive indexes in [0, n) for which `pred` holds, as inclusive [first, last] pairs. */
function runsWhere(n: number, pred: (i: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    if (!pred(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && pred(j + 1)) j++;
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

export function detectCreditCards(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const base = m.index;
    const groups: DigitGroup[] = [];
    let line = 0;
    let prevEnd = 0;
    for (const g of m[0].matchAll(/\d+/g)) {
      if (m[0].slice(prevEnd, g.index).includes("\n")) line++;
      groups.push({ start: base + g.index, end: base + g.index + g[0].length, digits: g[0], line });
      prevEnd = g.index + g[0].length;
    }
    const claimed = new Array<boolean>(groups.length).fill(false);
    const matches: Array<[number, number]> = [];
    const claim = (ws: Array<[number, number]>) => {
      for (const [a, b] of ws) {
        matches.push([a, b]);
        for (let k = a; k <= b; k++) claimed[k] = true;
      }
    };

    // 1. Prefer a card-shaped run on a single line: window search per line segment, so an unrelated
    //    group on the previous line cannot be paired with a card's leading groups.
    let s = 0;
    for (let k = 0; k < groups.length; k++) {
      if (k === groups.length - 1 || groups[k + 1]!.line !== groups[k]!.line) {
        claim(luhnWindows(groups, s, k));
        s = k + 1;
      }
    }
    // 2. Cross-line search only over groups no single-line match claimed (a PAN wrapped across lines).
    for (const [a, b] of runsWhere(groups.length, (k) => !claimed[k])) claim(luhnWindows(groups, a, b));

    if (matches.length === 0) continue;
    // 3. Residue rule: the candidate is one contiguous digit run (only separators between groups).
    //    If a match leaves any group in it unclaimed, mask the whole run as one card: never leave
    //    card-adjacent digit groups visible (over-masking is safe, under-masking is not).
    if (claimed.some((c) => !c)) {
      out.push(make("CREDIT_CARD", text, groups[0]!.start, groups[groups.length - 1]!.end));
      continue;
    }
    matches.sort((x, y) => x[0] - y[0]);
    for (const [a, b] of matches) out.push(make("CREDIT_CARD", text, groups[a]!.start, groups[b]!.end));
  }
  return out;
}

function hasSsnKeywordNear(text: string, start: number, end: number): boolean {
  const window = text.slice(Math.max(0, start - SSN_KEYWORD_BEFORE), Math.min(text.length, end + SSN_KEYWORD_AFTER));
  return SSN_KEYWORD_RE.test(window);
}

export function detectSSNs(text: string): Detection[] {
  const out: Detection[] = [];
  for (const re of [SSN_DASHED_RE, SSN_SPACED_RE]) {
    for (const m of text.matchAll(re)) out.push(make("SSN", text, m.index, m.index + m[0].length));
  }
  for (const m of text.matchAll(SSN_BARE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (hasSsnKeywordNear(text, start, end)) out.push(make("SSN", text, start, end));
  }
  return out.sort((a, b) => a.start - b.start);
}

export function detectPhones(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const n = digitCount(m[0]);
    const min = m[0].startsWith("+") ? PHONE_INTL_MIN_DIGITS : PHONE_MIN_DIGITS;
    if (n >= min && n <= PHONE_MAX_DIGITS) out.push(make("PHONE", text, m.index, m.index + m[0].length));
  }
  return out;
}

/**
 * Run all deterministic detectors in safety order: email, credit card (Luhn), SSN, phone.
 * Each later detector skips spans already claimed, so card fragments never become phones.
 * Result is non-overlapping and sorted by start.
 */
export function detectDeterministic(text: string): Detection[] {
  const taken: Detection[] = [];
  const passes: Array<(t: string) => Detection[]> = [detectEmails, detectCreditCards, detectSSNs, detectPhones];
  for (const pass of passes) {
    for (const d of pass(text)) {
      // Decision (operator, 2026-11-14): keep strict: an SSN adjacent to a card stays absorbed into CREDIT_CARD.
      if (!overlapsAny(d.start, d.end, taken)) taken.push(d);
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Detectors used to scan unmasked output and pre-flight payloads: email, SSN, Luhn-valid cards. */
export function detectHighRisk(text: string): Detection[] {
  const taken: Detection[] = [];
  for (const pass of [detectEmails, detectCreditCards, detectSSNs]) {
    for (const d of pass(text)) {
      if (!overlapsAny(d.start, d.end, taken)) taken.push(d);
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}
