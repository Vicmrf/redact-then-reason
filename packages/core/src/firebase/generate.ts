// Generation helpers (TECH-SPEC 3.3, 3.4).
import { InferenceSource } from "firebase/ai";
import { assertPreflight } from "../consent/preflight";
import { getCloudModel, getOnDeviceModel } from "./models";

export interface GenerateResult {
  text: string;
  inferenceSource: string;
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

export async function generateOnDevice(prompt: string): Promise<GenerateResult> {
  const result = await getOnDeviceModel().generateContent(prompt);
  const source = result.response.inferenceSource;
  if (source && source !== InferenceSource.ON_DEVICE) {
    throw new Error(`Refusing unexpected inference source: ${source}`);
  }
  return { text: result.response.text(), inferenceSource: source ?? InferenceSource.ON_DEVICE };
}

export async function generateOnDeviceStream(
  prompt: string,
  onChunk: (t: string) => void,
): Promise<GenerateResult> {
  const result = await getOnDeviceModel().generateContentStream(prompt);
  let text = "";
  for await (const chunk of result.stream) {
    const piece = chunk.text();
    text += piece;
    onChunk(piece);
  }
  const response = await result.response;
  const source = response.inferenceSource;
  if (source && source !== InferenceSource.ON_DEVICE) {
    throw new Error(`Refusing unexpected inference source: ${source}`);
  }
  return { text: response.text() || text, inferenceSource: source ?? InferenceSource.ON_DEVICE };
}

function assertInCloudSource(source: string | undefined): string {
  if (source && source !== InferenceSource.IN_CLOUD) {
    throw new Error(`Refusing unexpected inference source: ${source}`);
  }
  return source ?? InferenceSource.IN_CLOUD;
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
  const inferenceSource = assertInCloudSource(result.response.inferenceSource);
  return { text: result.response.text(), inferenceSource };
}

/** Streaming variant of generateInCloud (TECH-SPEC 7). Same contract and guards. */
export async function generateInCloudStream(
  redactedPayload: string,
  onChunk: (t: string) => void,
): Promise<GenerateResult> {
  assertPreflight(redactedPayload);
  const result = await getCloudModel().generateContentStream(redactedPayload);
  let text = "";
  for await (const chunk of result.stream) {
    const piece = chunk.text();
    text += piece;
    onChunk(piece);
  }
  const response = await result.response;
  const inferenceSource = assertInCloudSource(response.inferenceSource);
  return { text: response.text() || text, inferenceSource };
}
