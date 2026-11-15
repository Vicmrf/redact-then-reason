# Redact-then-Reason

A privacy-first Chrome extension (Manifest V3) and matching hosted web demo for sensitive documents: emails, patient portals, tax and HR forms, bills. On-device, it detects and redacts personal data, explains short documents and drafts replies with **Gemini Nano via Firebase AI Logic**. The cloud only ever receives a **redacted** copy, and only after you explicitly consent.

> **Status.** The extension side panel and the shared engine (`@rtr/core`) are built and working: deterministic + on-device-LLM PII detection and redaction, on-device explain and draft (`ONLY_ON_DEVICE`, streamed), the router, the consent gate with an exact-payload preview, the consented `ONLY_IN_CLOUD` path, the 🔒 / ☁️ badge bound to `inferenceSource`, and a five-theme UI. The hosted paste-text web demo (`packages/web-demo`) is built on the same `@rtr/core` and is ready to deploy to Firebase Hosting (see [Hosted web demo](#hosted-web-demo)). Design docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [TECH-SPEC](docs/TECH-SPEC.md), [BUILD-PLAN](docs/BUILD-PLAN.md).

## Privacy rule (the core design decision)

We never call Firebase AI Logic in any of the SDK's automatic-fallback modes with raw document text. Those modes silently fall back to the cloud when Gemini Nano is missing, still downloading, or cannot handle a request, which would send medical, tax or HR text off-device without consent.

Instead we pick the mode explicitly:

| Task | Firebase AI Logic mode | What is sent |
|---|---|---|
| PII detection, explain, draft (short / easy docs) | `InferenceMode.ONLY_ON_DEVICE` | Nothing leaves the device |
| Consented cloud reasoning (long docs, hard questions) | `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite` | Redacted text only, after you click Send in the consent preview |

The 🔒 / ☁️ badge is bound to `result.response.inferenceSource`. The placeholder map that links `[EMAIL_1]` back to the real value never leaves the device. Before any cloud call, a pre-flight check (emails / SSNs / cards / phones) and a placeholder-map leak check both run on the exact outgoing string, and an on-device entity pass must have completed; any of them failing disables Send.

## What's in the repo

```
packages/core        @rtr/core: Firebase AI Logic wrapper, Nano probe, redaction engine
                     (detect/merge/mask/unmask), router, consent pre-flight + leak checks
packages/extension   MV3 extension (Vite + CRXJS): side panel, capture, five themes
packages/web-demo    hosted paste-text demo (Vite), same @rtr/core, for Firebase Hosting
scripts/             icon generation
docs/                architecture, tech spec, build plan, Devpost draft
testdata/            synthetic fixtures (no real PII)
```

## Requirements (on-device path)

- **Chrome on Desktop 139+** (Windows 10/11, macOS 13+, Linux, or ChromeOS on Chromebook Plus). No mobile Chrome.
- Hardware floor for Gemini Nano:
  - **≥ 22 GB free** disk on the volume holding your Chrome profile (Chrome evicts the model below 10 GB).
  - GPU with **more than 4 GB VRAM**, or CPU with **≥ 16 GB RAM and ≥ 4 cores**.
  - An unmetered network connection for the first model download only.
- On weaker machines Nano reports `unavailable`. The redaction preview still works everywhere; the hosted web demo also demonstrates the consented cloud path.

### Chrome flags

Enable both, then **restart Chrome**:

1. In `chrome://flags`, search for **"Gemma 4 for Built-in AI"** and enable it (required for Gemini Nano 4).
2. `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**.

Optional check in DevTools: `await LanguageModel.availability()` should return `available`, `downloading`, or `downloadable`.

## Build

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm build            # runs `pnpm -r build` (core typecheck, extension, web-demo)
```

## Sideload the extension

1. `pnpm build` (above). The extension is emitted to `packages/extension/dist`.
2. In Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `packages/extension/dist`.
3. Click the toolbar icon to open the side panel.

### Try it

1. Paste a document, or use **Capture selection / Capture page** on a tab, or right-click → **Analyze with Redact-then-Reason**. Synthetic samples live in `testdata/` (e.g. `testdata/medical-email.txt`).
2. Click **Redact** — the preview shows typed placeholders (`[PERSON_1]`, `[EMAIL_1]`, `[MRN_1]`) and a pre-flight result.
3. Click **Explain on-device** or **Draft reply on-device** — answers stream in with a 🔒 badge; nothing leaves the device.
4. For a long document or a hard question, use **Use cloud for a deeper answer**. A consent dialog shows the **exact redacted text** that would be sent; only after you click **Send** does the `ONLY_IN_CLOUD` call run, and the answer is unmasked locally with a ☁️ badge.

## Hosted web demo

`packages/web-demo` is a paste-text page built on the same `@rtr/core`. It mirrors the extension: load a synthetic sample, **Redact**, **Explain / Draft on-device**, and the consent-gated cloud path with the exact-payload preview and 🔒 / ☁️ badges.

Run locally:

```sh
pnpm --filter @rtr/web-demo dev      # or: build + preview
pnpm --filter @rtr/web-demo build    # emits packages/web-demo/dist
```

Deploy to Firebase Hosting (config is in `firebase.json` / `.firebaserc`, project `redact-then-reason`):

```sh
pnpm --filter @rtr/web-demo build
firebase login                       # one-time, interactive
firebase deploy --only hosting --project redact-then-reason
```

The deployed URL is `https://redact-then-reason.web.app` (and `https://redact-then-reason.firebaseapp.com`). Update this line once the first deploy completes.

## Firebase + App Check setup (developers)

1. Create a Firebase project. Console → **AI Services → AI Logic → Get started** → **Gemini Developer API**. Confirm **Security → App Check → APIs → Firebase AI Logic** is **Enforced**. Register a **Web** app.
2. Copy `.env.example` to **`.env.local` in the repo root** and fill in the `VITE_FIREBASE_*` values from your web app's `firebaseConfig`. Every Vite config sets `envDir` to the repo root, so this one file serves both the extension and the web demo. `.env.local` is gitignored.
3. Keep `VITE_USE_APPCHECK_DEBUG=true` and leave `VITE_APPCHECK_DEBUG_TOKEN` empty. Build, load the extension, open the side panel, right-click it → **Inspect**, and find the console line `AppCheck debug token: "..."`.
4. Firebase console → **Security → App Check → Apps** → overflow menu → **Manage debug tokens** → register that token.
5. Paste the token into your **local** `.env.local` as `VITE_APPCHECK_DEBUG_TOKEN=...` so it stays stable across profile resets, then rebuild.

### App Check on the hosted demo: reCAPTCHA Enterprise

The MV3 extension can only use the App Check **debug provider** (reCAPTCHA Enterprise cannot load under the extension CSP; this is accepted by the hackathon). The **hosted web demo** should use **reCAPTCHA Enterprise** so a cold visitor's browser can run the consented cloud path with no setup. One-time steps:

1. Firebase console → **Security → App Check → Apps** → your **Web app** → **reCAPTCHA Enterprise** → register. Google Cloud creates a reCAPTCHA Enterprise **site key** (or create one in **Google Cloud Console → Security → reCAPTCHA Enterprise → Create key**, type **Website**).
2. Add your Hosting domains as **authorized domains / allowed domains** for that key: `redact-then-reason.web.app` and `redact-then-reason.firebaseapp.com` (and `localhost` for local testing).
3. Paste the site key into the repo-root `.env.local` as `VITE_RECAPTCHA_ENTERPRISE_KEY=...`, then rebuild and redeploy the web demo.

When `VITE_RECAPTCHA_ENTERPRISE_KEY` is set, the web demo's Vite build automatically switches off debug App Check and uses reCAPTCHA Enterprise (the extension build is separate and keeps the debug provider). Until the key is set, the deployed demo runs the **on-device** path with the debug provider, and the consented cloud path is wired but gated on the key (the Diagnostics panel shows the App Check mode and debug token).

Never commit `.env.local`, debug tokens, or service-account keys. If a page says *"Firebase not configured: copy .env.example to .env.local"*, step 2 is missing. A 403 mentioning App Check means a token/key step is missing.

## License

[Apache-2.0](LICENSE). English UI.
