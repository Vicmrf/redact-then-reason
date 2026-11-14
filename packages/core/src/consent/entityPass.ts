// Entity-pass status for the cloud send gate. Pure and generic: no UI copy.
//
// The on-device LLM entity pass (PERSON / ORG / ADDRESS / MRN / ACCOUNT / OTHER) is the only
// detector for names, organizations and addresses. If it did not complete for the current
// document, the redaction is regex-only and a cloud payload could still carry those values, so
// cloud send is refused. Fail closed: anything other than "complete" (including undefined or an
// unrecognized value read back from storage) blocks.

export const ENTITY_PASS_STATUSES = [
  "pending",
  "complete",
  "skipped_too_long",
  "unavailable",
  "failed",
] as const;

/**
 * - pending: not run (yet) for the current text (new document, edit, capture, in progress).
 * - complete: ran ONLY_ON_DEVICE on the whole document and its output parsed (zero entities is fine).
 * - skipped_too_long: document over the on-device extraction limit.
 * - unavailable: on-device model / SDK not available or not initialized.
 * - failed: the pass threw, the source was not on-device, or the output did not parse.
 */
export type EntityPassStatus = (typeof ENTITY_PASS_STATUSES)[number];

/** Narrows an unknown value (e.g. read from storage). Unknown / missing values become "pending". */
export function toEntityPassStatus(value: unknown): EntityPassStatus {
  return typeof value === "string" && (ENTITY_PASS_STATUSES as readonly string[]).includes(value)
    ? (value as EntityPassStatus)
    : "pending";
}

export function isEntityPassComplete(status: unknown): status is "complete" {
  return status === "complete";
}

export class EntityPassIncompleteError extends Error {
  /** The (non-complete) status only; never document content. */
  readonly status: EntityPassStatus;
  constructor(status: EntityPassStatus) {
    super(`Entity-pass check blocked: on-device entity pass status is "${status}". Nothing was sent.`);
    this.name = "EntityPassIncompleteError";
    this.status = status;
  }
}

/** Throws EntityPassIncompleteError unless the status is exactly "complete". */
export function assertEntityPassComplete(status: unknown): void {
  if (!isEntityPassComplete(status)) throw new EntityPassIncompleteError(toEntityPassStatus(status));
}
