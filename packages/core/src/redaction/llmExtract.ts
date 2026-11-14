// On-device LLM entity extraction (ARCHITECTURE 3.4 "LLM-extracted types", BUILD-PLAN Day 3).
// ONLY_ON_DEVICE structured output via getPiiModel(). Per ARCHITECTURE section 1 the PII
// pass receives the RAW text: it never leaves the device. The LLM pass is a recall boost,
// not the safety floor; deterministic detectors stay the source of truth (mergeDetections).
//
// Never log the raw text, the model output, or extracted entities: they are PII.

import { InferenceSource } from "firebase/ai";
import { getPiiModel } from "../firebase/models";
import type { Detection, EntityType } from "../types";

/** Types the on-device schema may return (piiSchema enum). */
export const LLM_ENTITY_TYPES = ["PERSON", "ORG", "ADDRESS", "MRN", "ACCOUNT", "OTHER"] as const;
export type LlmEntityType = (typeof LLM_ENTITY_TYPES)[number];

/** Raw entity as the model returns it (before verification). */
export interface LlmEntity {
  type: string;
  text: string;
  start?: number;
  end?: number;
}

/** Above this many characters Day 3 skips the LLM pass (chunking lands on Day 7). */
export const LLM_EXTRACT_MAX_CHARS = 12_000;

export const LLM_SKIPPED_TOO_LONG_NOTE =
  "LLM entity pass skipped: document too long for on-device extraction (chunking lands later)";

export interface LlmExtractResult {
  detections: Detection[];
  /** Non-PII warnings (e.g. "model returned invalid JSON"). Safe to display. */
  warnings: string[];
}

export function buildPiiExtractPrompt(raw: string): string {
  return [
    "Find personal and identifying information in the document below.",
    "Return JSON matching the schema: {\"entities\": [{\"type\", \"text\", \"start\", \"end\"}]}.",
    "Types:",
    "- PERSON: names of people.",
    "- ORG: names of companies, clinics, hospitals, agencies, employers, schools.",
    "- ADDRESS: street or postal addresses.",
    "- MRN: medical record numbers, member IDs, patient IDs.",
    "- ACCOUNT: account, policy, case, or reference numbers.",
    "- OTHER: any other identifying detail about a specific person.",
    "Rules:",
    "- \"text\" must be an EXACT substring copied character-for-character from the document. Do not paraphrase, normalize, abbreviate, or correct it.",
    "- \"start\" and \"end\" are optional 0-based character offsets into the document (end exclusive). Omit them if unsure.",
    "- List each distinct entity once. Do not invent entities. If there are none, return {\"entities\": []}.",
    "",
    "Document:",
    "<<<",
    raw,
    ">>>",
  ].join("\n");
}

function toEntityType(t: string): EntityType | null {
  const up = t.trim().toUpperCase();
  return (LLM_ENTITY_TYPES as readonly string[]).includes(up) ? (up as EntityType) : null;
}

/**
 * Pure. Keeps only entities whose text really occurs in `source` (ARCHITECTURE 3.4):
 * if start/end are present and `source.slice(start, end) === text`, use them; otherwise
 * search with indexOf from a moving cursor (per text), so repeated names map to successive
 * occurrences. Empty / whitespace-only / hallucinated texts and unknown types are dropped.
 */
export function verifyLlmSpans(source: string, entities: readonly LlmEntity[]): Detection[] {
  const out: Detection[] = [];
  const cursors = new Map<string, number>();
  const seen = new Set<string>();

  for (const e of entities) {
    if (!e || typeof e.text !== "string" || typeof e.type !== "string") continue;
    const type = toEntityType(e.type);
    if (!type) continue;
    const text = e.text;
    if (text.trim() === "") continue;

    let start = -1;
    if (
      Number.isInteger(e.start) &&
      Number.isInteger(e.end) &&
      e.start! >= 0 &&
      e.end! <= source.length &&
      source.slice(e.start!, e.end!) === text
    ) {
      start = e.start!;
    } else {
      const from = cursors.get(text) ?? 0;
      start = source.indexOf(text, from);
      if (start < 0 && from > 0) start = source.indexOf(text); // repeated listing of one occurrence
      if (start < 0) continue; // hallucinated: not in the source
      cursors.set(text, start + text.length);
    }

    const end = start + text.length;
    const key = `${start}:${end}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, start, end, text, source: "llm" });
  }
  return out;
}

/** Defensive parse of the structured output. Never throws; never echoes the payload. */
export function parseLlmEntities(json: string): { entities: LlmEntity[]; ok: boolean } {
  try {
    const parsed: unknown = JSON.parse(json);
    const list =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { entities?: unknown }).entities)
        ? ((parsed as { entities: unknown[] }).entities)
        : null;
    if (!list) return { entities: [], ok: false };
    const entities = list.filter(
      (x): x is LlmEntity =>
        !!x && typeof x === "object" && typeof (x as LlmEntity).text === "string" && typeof (x as LlmEntity).type === "string",
    );
    return { entities, ok: true };
  } catch {
    return { entities: [], ok: false };
  }
}

/**
 * Runs the ONLY_ON_DEVICE structured extractor on the RAW text and returns verified
 * LLM detections. Throws if the SDK reports any inference source other than ON_DEVICE.
 * Bad JSON yields no detections plus a non-PII warning.
 */
export async function extractEntitiesOnDevice(raw: string): Promise<LlmExtractResult> {
  const result = await getPiiModel().generateContent(buildPiiExtractPrompt(raw));
  const source = result.response.inferenceSource;
  if (source && source !== InferenceSource.ON_DEVICE) {
    throw new Error(`Refusing unexpected inference source: ${source}`);
  }
  const { entities, ok } = parseLlmEntities(result.response.text());
  const warnings = ok ? [] : ["On-device entity extractor returned invalid JSON; using regex detections only."];
  return { detections: verifyLlmSpans(raw, entities), warnings };
}
