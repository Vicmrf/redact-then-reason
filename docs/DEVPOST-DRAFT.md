# DRAFT: Devpost write-up — Redact-then-Reason

> **DRAFT — not submitted.** Paste into the Devpost form when ready; Victor clicks Submit. No metrics are claimed; do not add any we have not measured.
>
> - Repo: https://github.com/Vicmrf/redact-then-reason (Apache-2.0)
> - Hosted demo: https://redact-then-reason.web.app
> - Video: TODO: YouTube link after recording (public or unlisted, never private; ≤ 3:00)
> - Platform: Web (Chrome) — Chrome MV3 side-panel extension + hosted web demo
> - Built with: Firebase AI Logic (Hybrid Inference, `firebase/ai`), Gemini Nano on-device, `gemini-3.5-flash-lite` in the cloud, Firebase App Check (reCAPTCHA Enterprise / debug provider), Firebase Hosting, TypeScript, Vite, CRXJS

## Tagline

Private help with sensitive documents: Gemini Nano redacts and reasons on your device; the cloud only ever sees a redacted copy, and only after you approve it.

## The problem

The documents people most need help with are the ones they least want to paste into a chatbot: a hospital bill, a benefits letter from HR, a tax notice, an email from a patient portal, a legal letter. People paste them into cloud LLMs anyway — and with them go names, emails, phone numbers, account and medical record numbers, SSNs and card numbers. Today the choice is "get help and send everything to a server" or "get no help."

## Who it is for

Anyone dealing with sensitive personal paperwork in Chrome: patients, employees, taxpayers, caregivers handling a family member's mail. It is also for people who must keep this data private, such as clinic staff or HR generalists.

## What it does

Redact-then-Reason is a Chrome side-panel extension (plus a hosted paste-text demo on the same engine). It:

1. **Redacts** personal data in the current document on the device — deterministic detectors (regex, plus a Luhn check for card numbers) run instantly, then an on-device Gemini Nano pass adds names, organizations and addresses. You see a preview with typed placeholders like `[PERSON_1]`, `[EMAIL_1]`, `[SSN_1]`.
2. **Explains** the document in plain language — on-device, with Gemini Nano.
3. **Drafts a reply** — on-device, from the redacted copy; the real details are filled back in locally.
4. **Escalates to the cloud only with consent** — for a long document or a deeper answer, you review the *exact* redacted text that would be sent, and nothing leaves the device until you click **Send redacted text to cloud**.

A 🔒 On-device / ☁️ Cloud badge shows where every answer actually came from.

## Why this is a true hybrid entry — how we use Firebase AI Logic

Every model call goes through the Firebase AI Logic Hybrid Inference SDK (`firebase/ai`, `getGenerativeModel` + `generateContent` / `generateContentStream`). The two inference paths are separate, and each one sets its mode explicitly:

1. **On-device by default: `InferenceMode.ONLY_ON_DEVICE` with Gemini Nano.**
   PII detection (with structured output), explanations and reply drafts all run locally. On first use, the app calls `initializeDeviceModel()` and shows download progress, then sends requests that cannot leave the machine.

2. **Cloud only with consent: `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite`.**
   When a document is too long for the on-device budget or a request is too hard, we do *not* fall back to the cloud on our own. A consent dialog explains why the cloud is being offered and shows the **exact redacted payload** and its character count. It runs the deterministic detectors again on that payload and blocks Send if anything still matches. Only after the user clicks **Send redacted text to cloud** does the cloud model see anything. The answer is unmasked locally.

**Why we never use the SDK's automatic-fallback modes on raw text.** Firebase AI Logic offers hybrid modes that prefer one side and fall back to the other on their own. They are convenient, but for this product they are unsafe: if Nano is missing, still downloading, or cannot handle a request, those modes quietly send the request to the cloud — which would mean raw medical or tax text leaves the device without consent. Our router chooses the mode, and the user approves every cloud call.

**A badge driven by `inferenceSource`.** The 🔒 / ☁️ badge reads `result.response.inferenceSource` from each response; we don't guess. The hosted demo prints the raw value under every answer. If a request meant to run on-device ever comes back from the cloud, we treat it as a bug and do not show the output.

**App Check.** Firebase AI Logic requires App Check. The sideloaded extension uses the App Check **debug provider**; the token is kept out of the repo. The hosted web demo uses **reCAPTCHA Enterprise** on its hosting domain, so judges can try the consented cloud path without any setup.

## What never leaves the device

- The original document text.
- The placeholder map linking `[EMAIL_1]` to the real address. In the extension it lives only in session storage and is cleared when the browser closes; in the hosted demo it stays in the page.
- Everything processed on the on-device path, including PII detection, explanations and drafts.

Only the redacted text the user has approved, plus their request, ever reaches the cloud.

## How it is built

- **`@rtr/core`** (TypeScript): the Firebase AI Logic wrapper (on-device and cloud models), the redaction engine (regex + Luhn detectors, on-device entity pass, overlap merge, placeholder mask/unmask), the router (on-device token budget + "hard request" rules) and the consent checks (pre-flight detectors on the outgoing payload, placeholder-map leak check).
- **Chrome extension** (MV3 side panel, Vite + CRXJS): captures the current tab's text, a selection, or pasted text, and runs the same core.
- **Hosted web demo** (Vite, Firebase Hosting): a paste-text version on the same `@rtr/core`, with three synthetic sample documents (medical billing email, longer tax notice, HR benefits letter) and a diagnostics panel. App Check via reCAPTCHA Enterprise.
- Apache-2.0, public repo, no real personal data in fixtures.

## How to try it

**Hosted demo (fastest):** open https://redact-then-reason.web.app → **Load a sample** → **Redact** → **Explain on-device** or **Draft reply on-device** (🔒). Then, under *Use cloud for a deeper answer*, click **Explain** → review the exact redacted text in the consent dialog → **Send redacted text to cloud** (☁️). The on-device path needs Chrome 139+ with Gemini Nano enabled (two flags, listed in the README); the Diagnostics panel shows Firebase / App Check and Nano status.

**Extension (sideload):** clone the repo, `pnpm install` and `pnpm build` (Node 24+), then in Chrome open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `packages/extension/dist`. Enable the two Chrome flags from the README, open the side panel from the toolbar icon, and analyze any page.

## Challenges

- Keeping the cloud path strictly opt-in meant *not* using the SDK's convenient automatic-fallback modes and writing our own router and consent gate instead.
- On-device extraction can miss or invent spans, so detections from the Nano pass are verified against the source text before they are merged with the deterministic detectors.
- Making the cloud path work for a judge's cold browser required reCAPTCHA Enterprise App Check on the hosting domain, separate from the extension's debug provider.

## What's next

- **Real-inbox capture:** site-specific extractors for Gmail and Outlook web, and PDF text-layer extraction so bills and notices opened as PDFs work directly.
- **Better redaction coverage:** more identifier types and non-US formats (IBANs, national IDs, international phone numbers), and a scan of model output for anything that still looks like personal data.
- **Contract Gotcha-highlighter:** a second mode on the same `@rtr/core` that flags fees, auto-renewals, arbitration and early-termination clauses in leases and contracts.
- **Remote Config** for the on-device budget and cloud model name, so routing can be tuned without shipping a new build.
- **Chrome Web Store** publication after the hackathon, so people can install it without sideloading.
