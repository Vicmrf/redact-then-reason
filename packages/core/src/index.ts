export const CORE_VERSION = "0.1.0";

export {
  initFirebase,
  isFirebaseInitialized,
  FirebaseNotConfiguredError,
  type FirebaseHandles,
} from "./firebase/init";
export {
  CLOUD_MODEL_NAME,
  ON_DEVICE_PARAMS,
  piiSchema,
  getOnDeviceModel,
  getCloudModel,
  getPiiModel,
} from "./firebase/models";
export {
  startDeviceModel,
  generateOnDevice,
  generateOnDeviceStream,
  generateInCloud,
  type GenerateResult,
} from "./firebase/generate";
export { probeNano, TEXT_OPTS } from "./firebase/probe";

// Re-exported so UI packages compare against the SDK constants, not guessed strings.
export { InferenceSource } from "firebase/ai";
