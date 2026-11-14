// Consent-gate primitives (ARCHITECTURE 5). Pure and generic: no UI copy.
//
// buildCloudPayload composes the EXACT string that may be sent to the cloud, built ONLY from the
// redacted document + the user's question / instruction + prompt boilerplate. It never takes the
// raw text or the PlaceholderMap. The UI shows `payload.text` verbatim in the consent preview and
// later passes that same string to generateInCloud* (which re-runs the pre-flight check).
import type { EntityType, PlaceholderMap, TypeCount } from "../types";
import { buildExplainPrompt } from "../prompts/explain";
import { buildDraftPrompt } from "../prompts/draft";
import { preflightCheck, type PreflightResult } from "./preflight";

export type CloudAction = { kind: "explain" } | { kind: "draft"; instruction?: string };

export interface CloudPayload {
  readonly action: CloudAction["kind"];
  /** The exact outgoing string. Show it, then send this same value. */
  readonly text: string;
  /** Pre-flight on the FINAL payload (not just the redacted document). */
  readonly preflight: PreflightResult;
}

export function buildCloudPayload(redactedDoc: string, action: CloudAction): CloudPayload {
  const text =
    action.kind === "explain" ? buildExplainPrompt(redactedDoc) : buildDraftPrompt(redactedDoc, action.instruction);
  return Object.freeze({ action: action.kind, text, preflight: preflightCheck(text) });
}

/** Stable display order for masked-type summaries. */
export const ENTITY_TYPE_ORDER: readonly EntityType[] = [
  "PERSON", "EMAIL", "PHONE", "SSN", "CREDIT_CARD", "ADDRESS", "ORG",
  "DOB", "DATE", "ACCOUNT", "MRN", "IP", "OTHER",
];

/** Distinct masked values per type (one map entry per unique original). Never returns raw values. */
export function summarizeMasked(map: PlaceholderMap): TypeCount[] {
  const counts = new Map<EntityType, number>();
  for (const e of map.entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return ENTITY_TYPE_ORDER.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
}
