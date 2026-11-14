// Deterministic detectors (ARCHITECTURE 3.4 table, TECH-SPEC 6).
// These are the safety floor for well-structured identifiers. Never log matched values.
//
// TODO(Day 3+): DOB / DATE, ACCOUNT, IP, MRN detectors (ARCHITECTURE 3.4 table) are not implemented yet.

import type { Detection, EntityType } from "../types";
import { luhnOk } from "./luhn";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Candidate digit runs with optional single space/dash separators. The exact
// 13-19 digit card is chosen afterwards by a window search + Luhn.
const CARD_CANDIDATE_RE = /(?<![\w-])\d(?:[ -]?\d){12,}(?!\w)/g;

const SSN_DASHED_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const SSN_BARE_RE = /\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g;
const SSN_KEYWORD_RE = /\b(?:ssn|social\s+security|itin|tin)\b/i;
const SSN_KEYWORD_BEFORE = 40;
const SSN_KEYWORD_AFTER = 20;

// Optional "+CC " (or a bare NANP "1-"), then groups of 2-4 digits (first may be parenthesized) joined by
// a single space, dot or dash. Post-filtered to 10-15 digits.
const PHONE_RE = /(?<![\w+./-])(?:\+\d{1,3}[ .-]?|1[ .-])?(?:\(\d{2,4}\)|\d{2,4})(?:[ .-]?\d{2,4}){1,5}(?!\w)/g;

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

export function detectCreditCards(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const base = m.index;
    const groups = [...m[0].matchAll(/\d+/g)].map((g) => ({
      start: base + g.index,
      end: base + g.index + g[0].length,
      digits: g[0],
    }));
    // Window search over separator-delimited groups: from each start group, take the
    // longest run of whole groups that is 13-19 digits and passes Luhn.
    let i = 0;
    while (i < groups.length) {
      let found = -1;
      for (let j = groups.length - 1; j >= i; j--) {
        let digits = "";
        for (let k = i; k <= j; k++) digits += groups[k]!.digits;
        if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        out.push(make("CREDIT_CARD", text, groups[i]!.start, groups[found]!.end));
        i = found + 1;
      } else {
        i++;
      }
    }
  }
  return out;
}

function hasSsnKeywordNear(text: string, start: number, end: number): boolean {
  const window = text.slice(Math.max(0, start - SSN_KEYWORD_BEFORE), Math.min(text.length, end + SSN_KEYWORD_AFTER));
  return SSN_KEYWORD_RE.test(window);
}

export function detectSSNs(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(SSN_DASHED_RE)) {
    out.push(make("SSN", text, m.index, m.index + m[0].length));
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
    if (n >= 10 && n <= 15) out.push(make("PHONE", text, m.index, m.index + m[0].length));
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
