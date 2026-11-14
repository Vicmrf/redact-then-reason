// Pre-send sequence for the consent gate's Send click (ARCHITECTURE 5). Injectable so it is unit
// testable: every check runs on the exact payload string BEFORE `generate` is called, and on any
// failure `generate` is never called (the returned promise rejects with the typed error).
import {
  assertEntityPassComplete,
  assertNoMapLeaks,
  assertPreflight,
  type EntityPassStatus,
  type PlaceholderMap,
} from "@rtr/core";

export interface GuardedSendInput {
  /** The exact previewed payload; this same string is what `generate` receives. */
  payload: string;
  map: PlaceholderMap;
  /** Entity-pass status for the current document. Anything but "complete" (incl. undefined) blocks. */
  entityPass: EntityPassStatus | undefined;
}

export async function sendToCloudGuarded<T>(
  input: GuardedSendInput,
  generate: (payload: string) => Promise<T>,
): Promise<T> {
  assertEntityPassComplete(input.entityPass); // EntityPassIncompleteError
  assertPreflight(input.payload); // PreflightError
  assertNoMapLeaks(input.payload, input.map); // MapLeakError
  return generate(input.payload);
}
