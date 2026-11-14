// Shared redaction types (ARCHITECTURE section 3.4).

export type EntityType =
  | "EMAIL" | "PHONE" | "SSN" | "CREDIT_CARD" | "DOB" | "DATE"
  | "ACCOUNT" | "IP" | "MRN" | "PERSON" | "ORG" | "ADDRESS" | "OTHER";

export interface PlaceholderEntry {
  token: string;       // "[EMAIL_1]"
  type: EntityType;
  original: string;    // raw PII, in memory / session store only
  start: number;
  end: number;
}

export interface PlaceholderMap {
  docId: string;
  createdAt: number;
  entries: PlaceholderEntry[]; // token is unique
}

/** Where a detection came from: deterministic regex/validators, or the on-device LLM pass (Day 3). */
export type DetectionSource = "regex" | "llm";

/** A detected span in the source text. `end` is exclusive; `text === source.slice(start, end)`. */
export interface Detection {
  type: EntityType;
  start: number;
  end: number;
  text: string;
  source: DetectionSource;
}

/** Per-type count. Never carries raw values. */
export interface TypeCount {
  type: EntityType;
  count: number;
}
