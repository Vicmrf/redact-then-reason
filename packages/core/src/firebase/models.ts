// Model instances (TECH-SPEC 3.2). One instance per mode; never reuse across modes.
// Created lazily so importing @rtr/core never touches Firebase until initFirebase() works.
import {
  getGenerativeModel,
  InferenceMode,
  Schema,
  type GenerativeModel,
  type OnDeviceParams,
} from "firebase/ai";
import { initFirebase } from "./init";

/** Cloud model: billing not required, SDK default since v13.0.0. */
export const CLOUD_MODEL_NAME = "gemini-3.5-flash-lite";

export const ON_DEVICE_PARAMS: OnDeviceParams = {
  createOptions: {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    initialPrompts: [
      {
        role: "system",
        content: [
          {
            type: "text",
            value:
              "You are a careful assistant for sensitive personal documents. Be concise and factual. When you see placeholders like [EMAIL_1] or [SSN_1], copy them verbatim and never invent values for them.",
          },
        ],
      },
    ],
  },
};

export const piiSchema = Schema.object({
  properties: {
    entities: Schema.array({
      items: Schema.object({
        properties: {
          type: Schema.enumString({
            enum: ["PERSON", "ORG", "ADDRESS", "MRN", "ACCOUNT", "OTHER"],
          }),
          text: Schema.string(),
          start: Schema.integer(),
          end: Schema.integer(),
        },
        optionalProperties: ["start", "end"],
      }),
    }),
  },
});

let onDeviceModel: GenerativeModel | null = null;
let cloudModel: GenerativeModel | null = null;
let piiModel: GenerativeModel | null = null;

/** ONLY_ON_DEVICE: raw text allowed, it never leaves the device. */
export function getOnDeviceModel(): GenerativeModel {
  onDeviceModel ??= getGenerativeModel(initFirebase().ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
  });
  return onDeviceModel;
}

/** ONLY_IN_CLOUD: redacted text only, and only after the consent modal (Day 5). */
export function getCloudModel(): GenerativeModel {
  cloudModel ??= getGenerativeModel(initFirebase().ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: CLOUD_MODEL_NAME,
      generationConfig: { maxOutputTokens: 2048 },
    },
  });
  return cloudModel;
}

/** On-device structured PII extractor. No cloud configuration, by design. */
export function getPiiModel(): GenerativeModel {
  piiModel ??= getGenerativeModel(initFirebase().ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      ...ON_DEVICE_PARAMS,
      promptOptions: { responseConstraint: piiSchema },
    },
  });
  return piiModel;
}
