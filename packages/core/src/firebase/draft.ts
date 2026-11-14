// On-device draft reply (BUILD-PLAN Day 4). ONLY_ON_DEVICE via generateOnDeviceStream, which
// refuses any non-ON_DEVICE inferenceSource. There is no cloud fallback here, by design.
import { buildDraftPrompt, draftFitsOnDevice, TOO_LONG_FOR_DRAFT } from "../prompts/draft";
import { generateOnDeviceStream } from "./generate";

export type DraftOutcome =
  | { kind: "too_long"; message: string }
  | { kind: "ok"; text: string; inferenceSource: string };

/**
 * Streams a reply draft for the REDACTED document. The returned text still contains
 * placeholders; the caller unmasks it locally with the placeholder map (never sent anywhere).
 */
export async function draftReplyOnDevice(
  redactedDoc: string,
  instruction: string | undefined,
  onChunk: (t: string) => void,
): Promise<DraftOutcome> {
  const prompt = buildDraftPrompt(redactedDoc, instruction);
  if (!draftFitsOnDevice(prompt)) return { kind: "too_long", message: TOO_LONG_FOR_DRAFT };
  const { text, inferenceSource } = await generateOnDeviceStream(prompt, onChunk);
  return { kind: "ok", text, inferenceSource };
}
