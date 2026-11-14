# Redact-then-Reason

A privacy-first Chrome extension (Manifest V3) for sensitive documents: emails, patient portals, tax and HR forms, bills. On-device, it detects and redacts personal data, explains short documents and drafts replies with **Gemini Nano via Firebase AI Logic**. The cloud only ever receives a **redacted** copy, and only after you explicitly consent.

> **Status: Day 1.** This build is a stack check. The side panel initializes Firebase + App Check, downloads/initializes Gemini Nano on a click, runs one `ONLY_ON_DEVICE` `generateContent` call, and shows the response and its `inferenceSource`. Redaction, routing, the consent modal and page capture are not built yet. Design docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [TECH-SPEC](docs/TECH-SPEC.md), [BUILD-PLAN](docs/BUILD-PLAN.md).

## Privacy rule (the core design decision)

We never call Firebase AI Logic in any of the SDK's automatic-fallback modes with raw document text. Those modes silently fall back to the cloud when Gemini Nano is missing, still downloading, or cannot handle a request, which would send medical, tax or HR text off-device without consent.

Instead we pick the mode explicitly:

| Task | Firebase AI Logic mode | What is sent |
|---|---|---|
| PII detection, explain, draft (short / easy docs) | `InferenceMode.ONLY_ON_DEVICE` | Nothing leaves the device |
| Consented cloud reasoning (long docs, hard questions) | `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite` | Redacted text only, after you click Send in the consent preview |

The 🔒 / ☁️ badge is bound to `result.response.inferenceSource`. The placeholder map that links `[EMAIL_1]` back to the real value never leaves the device.

## Requirements

- **Chrome on Desktop 139+** (Windows 10/11, macOS 13+, Linux, or ChromeOS on Chromebook Plus). No mobile Chrome.
- Hardware floor for Gemini Nano:
  - **≥ 22 GB free** disk on the volume holding your Chrome profile (Chrome evicts the model below 10 GB).
  - GPU with **more than 4 GB VRAM**, or CPU with **≥ 16 GB RAM and ≥ 4 cores**.
  - An unmetered network connection for the first model download only.
- On weaker machines Nano reports `unavailable`. The hosted web demo (coming Day 6) still demonstrates the consented cloud path.

### Chrome flags

Enable both, then **restart Chrome**:

1. In `chrome://flags`, search for **"Gemma 4 for Built-in AI"** and enable it (required for Gemini Nano 4).
2. `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**.

Optional check in DevTools: `await LanguageModel.availability()` should return `available`, `downloading`, or `downloadable`.

## Build and sideload

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm build            # runs `pnpm -r build`
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `packages/extension/dist`. Click the toolbar icon to open the side panel.

## Firebase + App Check setup (developers)

1. Create a Firebase project. Console → **AI Services → AI Logic → Get started** → **Gemini Developer API**. Confirm **Security → App Check → APIs → Firebase AI Logic** is **Enforced**. Register a **Web** app.
2. Copy `.env.example` to **`.env.local` in the repo root** and fill in the `VITE_FIREBASE_*` values from your web app's `firebaseConfig`. Every Vite config sets `envDir` to the repo root, so this one file serves both the extension and the web demo. `.env.local` is gitignored.
3. Keep `VITE_USE_APPCHECK_DEBUG=true` and leave `VITE_APPCHECK_DEBUG_TOKEN` empty. Build, load the extension, open the side panel, right-click it → **Inspect**, and find the console line `AppCheck debug token: "..."`.
4. Firebase console → **Security → App Check → Apps** → overflow menu → **Manage debug tokens** → register that token.
5. Paste the token into your **local** `.env.local` as `VITE_APPCHECK_DEBUG_TOKEN=...` so it stays stable across profile resets, then rebuild.

Never commit `.env.local`, debug tokens, or service-account keys. The extension uses the App Check debug provider (accepted by the hackathon); the hosted demo will use reCAPTCHA Enterprise on its hosting domain only.

If the side panel says *"Firebase not configured: copy .env.example to .env.local"*, step 2 is missing. A 403 mentioning App Check means step 4 or 5 is missing.

## Repository layout

```
packages/core        @rtr/core: Firebase AI Logic wrapper, Nano probe (redaction/router: Day 2+)
packages/extension   MV3 extension (Vite + CRXJS), side panel
packages/web-demo    hosted paste-text demo (placeholder until Day 6)
scripts/gen-icons.mjs  regenerates placeholder icons
docs/                architecture, tech spec, build plan, Devpost draft
```

## License

[Apache-2.0](LICENSE). English UI.
