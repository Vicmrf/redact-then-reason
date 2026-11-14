// Generation helpers (TECH-SPEC 3.3, 3.4).
import { InferenceSource } from "firebase/ai";
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

/**
 * Consented cloud call. Callers MUST pass already-redacted text and only after
 * the consent modal's Send click (ARCHITECTURE section 5). Not wired into any UI yet.
 */
export async function generateInCloud(redactedPrompt: string): Promise<GenerateResult> {
  const result = await getCloudModel().generateContent(redactedPrompt);
  return {
    text: result.response.text(),
    inferenceSource: result.response.inferenceSource ?? InferenceSource.IN_CLOUD,
  };
}
