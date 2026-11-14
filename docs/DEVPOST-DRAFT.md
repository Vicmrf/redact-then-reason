# DRAFT: Devpost write-up — Redact-then-Reason

> **DRAFT, not final.** Written on Day 1 so this section is not written on deadline day. Update once the features are built and tested. No metrics yet; do not add any we have not measured.
>
> - Repo: TODO (public GitHub URL)
> - Hosted demo: TODO (Firebase Hosting URL)
> - Video: TODO (YouTube URL, public or unlisted)

## The problem

The documents people most need help with are the ones they least want to paste into a chatbot: a hospital bill, a benefits letter from HR, a tax notice, an email from a patient portal. Today the choice is "get help and send everything to a server" or "get no help."

## Who it is for

Anyone dealing with sensitive personal paperwork in Chrome: patients, employees, taxpayers, caregivers handling a family member's mail. It is also for people who must keep this data private, such as clinic staff or HR generalists.

## What it does

Redact-then-Reason is a Chrome side-panel extension. It detects and redacts personal data in the current document, explains it in plain language, and drafts a reply. By default, all of that runs on the device.

## How we use Firebase AI Logic

The extension makes every model call through Firebase AI Logic (`firebase/ai`, `getGenerativeModel` + `generateContent` / `generateContentStream`). The two inference paths are separate, and each one sets its mode explicitly:

1. **On-device by default: `InferenceMode.ONLY_ON_DEVICE` with Gemini Nano.**
   PII detection (with structured output), explanations and reply drafts all run locally. On the user's first click, the side panel calls `initializeDeviceModel()` and shows download progress, then sends requests that cannot leave the machine.

2. **Cloud only with consent: `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite`.**
   When a document is too long for the on-device budget or a question is too hard, we do *not* fall back to the cloud on our own. A consent modal shows the **exact redacted payload**, with placeholders like `[PERSON_1]`, `[EMAIL_1]` and `[SSN_1]`. It runs the deterministic detectors again on that payload and blocks Send if anything still matches. Only after the user clicks **Send redacted text to cloud** does the cloud model see anything. The answer is unmasked locally.

**Why we never use the SDK's automatic-fallback modes on raw text.** Firebase AI Logic offers hybrid modes that prefer one side and fall back to the other on their own. They are convenient, but for this product they are unsafe. If Nano is missing, still downloading, or cannot handle a request, those modes quietly send the request to the cloud, which would mean raw medical or tax text leaves the device without consent. Our router chooses the mode, and the user approves every cloud call.

**A badge driven by `inferenceSource`.** The 🔒 On-device / ☁️ Cloud badge reads `result.response.inferenceSource` from each response; we don't guess. If a request meant to run on-device ever comes back from the cloud, we treat it as a bug and do not show the output.

**App Check.** Firebase AI Logic requires App Check. The sideloaded extension uses the App Check **debug provider**; the token is kept out of the repo. The hosted web demo uses **reCAPTCHA Enterprise** on its hosting domain, so judges can try the consented cloud path without any setup.

## What never leaves the device

- The original document text.
- The placeholder map linking `[EMAIL_1]` to the real address. It lives only in session storage and is cleared when the browser closes.
- Everything processed on the on-device path, including PII detection, explanations and drafts.

Only the redacted text the user has approved, plus their question, ever reaches the cloud.

## How it is built

TypeScript, a Chrome MV3 side panel (Vite + CRXJS), and a shared `@rtr/core` package that holds the Firebase AI Logic wrapper and, from Day 2 on, the redaction engine, router and consent checks. Apache-2.0.

## What's next

TODO: fill in after the MVP checkpoint.
