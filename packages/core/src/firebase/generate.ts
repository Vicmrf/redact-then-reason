// Generation helpers (TECH-SPEC 3.3, 3.4).
import { InferenceSource } from "firebase/ai";
import { assertPreflight } from "../consent/preflight";
import { getCloudModel, getOnDeviceModel } from "./models";

export interface GenerateResult {
  text: string;
  /** Exactly what the SDK reported (never inferred: a missing source is an error). */
  inferenceSource: string;
  /**
   * False when the model stopped for any reason other than a natural stop (cloud finishReason
   * other than "STOP": MAX_TOKENS, SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII,
   * OTHER, ..., or not reported at all). `text` is then partial and must not be shown as final.
   * On-device responses carry no finishReason in the SDK (ChromeAdapterImpl.toResponse /
   * toStreamResponse), so on-device results are complete when the stream ends normally.
   */
  complete: boolean;
  /** Cloud finishReason as reported, or "NOT_REPORTED" for a cloud answer without one. */
  finishReason?: string;
}

/** SDK FinishReason.STOP. */
const FINISH_STOP = "STOP";
export const FINISH_NOT_REPORTED = "NOT_REPORTED";

interface CandidateLike {
  finishReason?: string;
}
interface ResponseLike {
  text: () => string;
  candidates?: CandidateLike[];
  inferenceSource?: string;
}

function finishReasonOf(r: ResponseLike | undefined): string | undefined {
  const fr = r?.candidates?.[0]?.finishReason;
  return typeof fr === "string" && fr.length > 0 ? fr : undefined;
}

/**
 * response.text() throws an AIError for "bad" finish reasons (SAFETY, RECITATION, BLOCKLIST,
 * PROHIBITED_CONTENT, SPII, ...). When the candidate carries such a reason we stop reading and
 * report it instead of throwing, so the caller can show the partial text as incomplete. Any
 * other throw (e.g. prompt blocked: no candidates) is rethrown.
 */
function readText(r: ResponseLike): { text: string; stoppedBy?: string } {
  try {
    return { text: r.text() };
  } catch (err) {
    const fr = finishReasonOf(r);
    if (fr && fr !== FINISH_STOP) return { text: "", stoppedBy: fr };
    throw err;
  }
}

/** Throws unless the SDK explicitly reported `expected` (SDK always sets it for these calls). */
function requireSource(source: string | undefined, expected: string): string {
  if (!source) throw new Error(`Refusing response: the SDK did not report an inference source (expected ${expected}).`);
  if (source !== expected) throw new Error(`Refusing unexpected inference source: ${source}`);
  return source;
}

/**
 * Shared stream reader: concatenates chunk text; stops at a bad finish reason. Every chunk's
 * inferenceSource (the SDK sets it on each chunk) is checked BEFORE its text reaches onChunk.
 */
async function readStream(
  result: { stream: AsyncIterable<ResponseLike>; response: Promise<ResponseLike> },
  expectedSource: string,
  onChunk: (t: string) => void,
): Promise<{ text: string; response: ResponseLike; stoppedBy?: string; lastChunkReason?: string }> {
  let text = "";
  let stoppedBy: string | undefined;
  let lastChunkReason: string | undefined;
  for await (const chunk of result.stream) {
    requireSource(chunk.inferenceSource, expectedSource);
    const piece = readText(chunk);
    lastChunkReason = finishReasonOf(chunk) ?? lastChunkReason;
    if (piece.text) {
      text += piece.text;
      onChunk(piece.text);
    }
    if (piece.stoppedBy) {
      stoppedBy = piece.stoppedBy;
      break;
    }
  }
  const response = await result.response;
  return { text, response, stoppedBy, lastChunkReason };
}

/** Cloud completion: complete only with an explicit STOP finish reason. */
function cloudFinish(reported: string | undefined): { complete: boolean; finishReason: string } {
  const finishReason = reported ?? FINISH_NOT_REPORTED;
  return { complete: finishReason === FINISH_STOP, finishReason };
}

let deviceInit: Promise<void> | null = null;

/**
 * Starts (or joins) the Gemini Nano download/initialization. Memoized.
 * Must be called from a user gesture and awaited before the first on-device request.
 * onProgress receives 0..100.
 */
export function startDeviceModel(onProgress?: (pct: number) => void): Promise<void> {
  if (!deviceInit) {
    deviceInit = getOnDeviceModel()
      .initializeDeviceModel((val) => {
        // val is 0..1
        onProgress?.(Math.round(val * 10000) / 100);
      })
      .catch((err: unknown) => {
        // Allow a retry on the next click instead of caching a failure forever.
        deviceInit = null;
        throw err;
      });
  }
  return deviceInit;
}

/**
 * ONLY_ON_DEVICE single call. The SDK sets inferenceSource on every generateContent /
 * generateContentStream response (callCloudOrDevice), so a missing source is refused.
 */
export async function generateOnDevice(prompt: string): Promise<GenerateResult> {
  const result = await getOnDeviceModel().generateContent(prompt);
  const inferenceSource = requireSource(result.response.inferenceSource, InferenceSource.ON_DEVICE);
  return { text: result.response.text(), inferenceSource, complete: true };
}

export async function generateOnDeviceStream(
  prompt: string,
  onChunk: (t: string) => void,
): Promise<GenerateResult> {
  const result = await getOnDeviceModel().generateContentStream(prompt);
  const { text, response } = await readStream(result as never, InferenceSource.ON_DEVICE, onChunk);
  const inferenceSource = requireSource(response.inferenceSource, InferenceSource.ON_DEVICE);
  return { text: response.text() || text, inferenceSource, complete: true };
}

/**
 * Consented ONLY_IN_CLOUD call (ARCHITECTURE 1, 5).
 * `redactedPayload` MUST be the exact, already-redacted string the user reviewed in the consent
 * gate (built from the redacted document + question + prompt boilerplate; never raw text, never
 * the placeholder map), and the call must come from the consent Send click.
 * Second guard: the pre-flight check runs here again before any network call and throws
 * PreflightError if an email / SSN / card / phone is still present.
 */
export async function generateInCloud(redactedPayload: string): Promise<GenerateResult> {
  assertPreflight(redactedPayload);
  const result = await getCloudModel().generateContent(redactedPayload);
  const response = result.response as unknown as ResponseLike;
  const inferenceSource = requireSource(response.inferenceSource, InferenceSource.IN_CLOUD);
  const read = readText(response);
  return { text: read.text, inferenceSource, ...cloudFinish(read.stoppedBy ?? finishReasonOf(response)) };
}

/**
 * Streaming variant of generateInCloud (TECH-SPEC 7). Same contract and guards. A stream that
 * ends without a STOP finish reason (truncated, blocked, or not reported) resolves with
 * `complete: false` and the partial text; it never pretends to be a full answer.
 */
export async function generateInCloudStream(
  redactedPayload: string,
  onChunk: (t: string) => void,
): Promise<GenerateResult> {
  assertPreflight(redactedPayload);
  const result = await getCloudModel().generateContentStream(redactedPayload);
  const { text, response, stoppedBy, lastChunkReason } = await readStream(
    result as never,
    InferenceSource.IN_CLOUD,
    onChunk,
  );
  const inferenceSource = requireSource(response.inferenceSource, InferenceSource.IN_CLOUD);
  if (stoppedBy) return { text, inferenceSource, complete: false, finishReason: stoppedBy };
  const final = readText(response);
  const reported = final.stoppedBy ?? finishReasonOf(response) ?? lastChunkReason;
  return { text: final.text || text, inferenceSource, ...cloudFinish(reported) };
}
