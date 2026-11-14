# Redact-then-Reason — Technical Specification

Verified against official docs as of **2026-11-14**. If an SDK type or flag disagrees with this file, trust the linked doc and update this file — do not improvise API shapes.

Companion docs: [ARCHITECTURE.md](./ARCHITECTURE.md) (data flow, consent gate), [BUILD-PLAN.md](./BUILD-PLAN.md) (calendar).

---

## 1. Platform and toolchain

| Item | Choice | Why |
|---|---|---|
| Target | Chrome extension, Manifest V3, desktop only | Hackathon Web/Chrome track. On-device inference via Firebase AI Logic requires **Chrome on Desktop 139+**. |
| Language | TypeScript, strict | |
| Bundler | **Vite 7 + `@crxjs/vite-plugin`** | Explicit `manifest.json`, familiar Vite config, first-class MV3. WXT is a fine alternative (convention-based entrypoints) but CRXJS keeps the manifest reviewable in the repo for judges. Do not use Plasmo (less relevant in 2026; extra abstraction). |
| Package manager | pnpm workspaces | Shared `packages/core` for the Contract Gotcha spin-off. |
| License | Apache-2.0 (`LICENSE` in repo root) | Hackathon prefers Apache; any OSI license works. |
| Hosted demo | Vite web app on **Firebase Hosting** | Same Firebase project, same core package. Strongly encouraged by the FAQ. |

Minimum versions:

```
firebase@^13.3.0          # hybrid requires >=12.5.0; default cloud model gemini-3.5-flash-lite starts at 13.0.0
                          # 13.3.0 released 2026-11-11 — pin this or newer 13.x
vite@^7
@crxjs/vite-plugin@^2
typescript@^5.6
@types/chrome             # latest
@types/dom-chromium-ai    # Prompt API typings (availability probe only)
```

`firebase` is the only Firebase package to install. Imports are subpaths: `firebase/app`, `firebase/ai`, `firebase/app-check`. There is no separate `firebase-ai-logic` npm name.

---

## 2. Chrome / Gemini Nano 4 requirements

### 2.1 Browser and hardware

From the [Prompt API docs](https://developer.chrome.com/docs/ai/prompt-api) and [Firebase hybrid get-started](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started):

- **Chrome on Desktop 139+** (Firebase AI Logic on-device). Prompt API itself is stable for extensions since 138 and for the open web since 148; still require 139+ to match the SDK.
- OS: Windows 10/11, macOS 13+, Linux, or ChromeOS on Chromebook Plus (platform 16389.0.0+). No Android/iOS Chrome, no non-Plus ChromeOS.
- Storage: **≥ 22 GB free** on the volume that holds the Chrome profile. If free space later drops below 10 GB, Chrome evicts the model.
- Compute: GPU **> 4 GB VRAM**, *or* CPU with **≥ 16 GB RAM and ≥ 4 cores**.
- Network: unmetered connection **only for the first model download**. Subsequent on-device inference sends no data to Google.
- Model size fluctuates; check `chrome://on-device-internals`.

Victor's Darlikk (Windows, RTX 5090) exceeds these. Document them in the README so judges on weaker machines know why Nano is `unavailable` and that the consented cloud path (web demo) still works.

### 2.2 Flags the README must list

Enable and **restart Chrome**:

1. **`Gemma 4 for Built-in AI`** — required for Gemini Nano 4. Official hackathon FAQ: *In chrome://flags, search for "Gemma 4 for Built-in AI" and enable it.* ([FAQ](https://firebasehybridaihackathon.devpost.com/details/faqs))
2. **`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`** — set to Enabled. Required by the Firebase get-started guide if we ever send JPEG/PNG; enable it anyway so the environment matches the docs.

Optional check: `await LanguageModel.availability()` in DevTools should return `available`, `downloading`, or `downloadable`. If `downloadable`, `await LanguageModel.create()` (console only, for setup) starts the download. Product code should start the download via `model.initializeDeviceModel()`, not via `LanguageModel.create()`.

Remove any expired `"aiLanguageModelOriginTrial"` permission if a starter template added it.

### 2.3 Runtime availability probe

Use the same `expectedInputs` / `expectedOutputs` you will use for text inference. Values: `"unavailable"` | `"downloadable"` | `"downloading"` | `"available"`.

```ts
export const TEXT_OPTS = {
  expectedInputs: [{ type: "text" as const, languages: ["en"] }],
  expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

export async function probeNano(): Promise<string> {
  if (typeof LanguageModel === "undefined" || !LanguageModel.availability) {
    return "unavailable";
  }
  return LanguageModel.availability(TEXT_OPTS);
}
```

This probe is **not** inference. Do not use `LanguageModel.create()` / `prompt()` in product code.

---

## 3. Firebase AI Logic — exact init and usage

### 3.1 Backend and cloud model

- Backend: **`GoogleAIBackend`** (Gemini Developer API). Free tier, no billing account required. Do not use `AgentPlatformBackend` (formerly Vertex) — it expects billing.
- Cloud model: **`gemini-3.5-flash-lite`**. Billing not required, stable, no shutdown date, and the **default cloud model starting with JS SDK v13.0.0**. ([models](https://firebase.google.com/docs/ai-logic/models), [config options](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options))
- Do **not** use `gemini-2.5-flash` or `gemini-2.5-pro`. On the Developer API, those names start auto-routing to newer models on **2026-12-01** and may break prompts.
- Optional later upgrade for "hard" consented questions: `gemini-3.8-flash` (also billing not required). Keep Flash-Lite as the default.
- Do not use Nano Banana / TTS models (several are billing-required; we don't need them).

`firebaseConfig` (apiKey, authDomain, projectId, appId, messagingSenderId, storageBucket) is a **public client config**. It may be committed. It is not a secret. Do not commit service-account JSON, App Check debug tokens, or `.env` files.

### 3.2 Initialization (side panel only)

Call this once, on side-panel load, **App Check before `getAI`**.

```ts
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  Schema,
} from "firebase/ai";
import { firebaseConfig } from "./firebase-config";

// --- App Check: see §4. This MUST run before getAI(). ---
// In the extension debug build:
if (import.meta.env.DEV || import.meta.env.VITE_USE_APPCHECK_DEBUG === "true") {
  // Token comes from a gitignored env file. Never hardcode it.
  self.FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
}

const firebaseApp = initializeApp(firebaseConfig);

// initializeAppCheck still requires a provider object. In debug builds the
// FIREBASE_APPCHECK_DEBUG_TOKEN set above is what actually attests, even if
// the reCAPTCHA script cannot load under the extension CSP. Use a real
// Enterprise site key in the hosted demo; in the extension debug build a
// placeholder string is acceptable ONLY because the debug token is set first.
// Do not ship that placeholder build as a "production" extension.
const appCheck = initializeAppCheck(firebaseApp, {
  provider: new ReCaptchaEnterpriseProvider(
    import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY || "debug-build-no-recaptcha",
  ),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });

const ON_DEVICE_PARAMS = {
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

export const onDeviceModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: ON_DEVICE_PARAMS,
});

export const cloudModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: {
    model: "gemini-3.5-flash-lite",
    generationConfig: { maxOutputTokens: 2048 },
  },
});
```

For the PII-extractor instance, add structured-output config ([docs](https://firebase.google.com/docs/ai-logic/hybrid/web/generate-structured-output)):

```ts
const piiSchema = Schema.object({
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

export const piiModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    ...ON_DEVICE_PARAMS,
    promptOptions: { responseConstraint: piiSchema },
  },
});
```

If you ever run this schema in the cloud, you must *also* set `inCloudParams.generationConfig = { responseMimeType: "application/json", responseSchema: piiSchema }`. The PII pass is on-device only, so do not configure a cloud fallback for `piiModel`.

### 3.3 `initializeDeviceModel()` — after a user click, before the first prompt

```ts
let deviceInit: Promise<void> | null = null;

export function startDeviceModel(onProgress?: (pct: number) => void): Promise<void> {
  if (!deviceInit) {
    deviceInit = onDeviceModel.initializeDeviceModel((val) => {
      // val is 0..1
      onProgress?.(Math.round(val * 10000) / 100);
    });
  }
  return deviceInit;
}

// Hook this to the first real click in the panel ("Enable on-device AI" or "Analyze").
await startDeviceModel((pct) => setDownloadPct(pct));
```

Rules from [get-started Step 6](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started):

- Must run after or on an end-user interaction (button click).
- Must run before `generateContent()`.
- Download can take several minutes. Show progress.
- For `ONLY_ON_DEVICE`, **await** the promise so the first request is not stuck waiting with no UI, or so you do not throw mid-download depending on SDK timing. Prefer: await, with a progress UI.
- For `PREFER_*` modes (which we do not use on raw text), a request made before the download finishes falls back to the cloud — another reason those modes are unsafe for this product.

### 3.4 Generate, read source, stream

```ts
import { InferenceSource } from "firebase/ai";

export async function generateOnDevice(prompt: string): Promise<{
  text: string;
  inferenceSource: string;
}> {
  const result = await onDeviceModel.generateContent(prompt);
  const source = result.response.inferenceSource;
  if (source && source !== InferenceSource.ON_DEVICE) {
    throw new Error(`Refusing unexpected inference source: ${source}`);
  }
  return { text: result.response.text(), inferenceSource: source ?? InferenceSource.ON_DEVICE };
}

export async function generateOnDeviceStream(
  prompt: string,
  onChunk: (t: string) => void,
): Promise<{ text: string; inferenceSource: string }> {
  const result = await onDeviceModel.generateContentStream(prompt);
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

export async function generateInCloud(redactedPrompt: string) {
  const result = await cloudModel.generateContent(redactedPrompt);
  return {
    text: result.response.text(),
    inferenceSource: result.response.inferenceSource ?? InferenceSource.IN_CLOUD,
  };
}
```

Enum values (compare with the imported constants, not with guessed uppercase strings):

- `InferenceMode.ONLY_ON_DEVICE === "only_on_device"`
- `InferenceMode.ONLY_IN_CLOUD === "only_in_cloud"`
- `InferenceMode.PREFER_ON_DEVICE === "prefer_on_device"` — **do not use on raw docs**
- `InferenceMode.PREFER_IN_CLOUD === "prefer_in_cloud"` — **do not use on raw docs**
- `InferenceSource.ON_DEVICE === "on_device"`
- `InferenceSource.IN_CLOUD === "in_cloud"`

The configuration-options prose says the property returns `ON_DEVICE` or `IN_CLOUD`; the JS reference defines the actual strings as `"on_device"` / `"in_cloud"`. Use the `InferenceSource.*` constants.

### 3.5 On-device limits that affect the router

- Single-turn text generation only (streaming allowed). **No `startChat()` / multi-turn** on-device.
- Text-only, or text + JPEG/PNG. No PDF/audio/video/URL file parts on-device.
- Structured output (JSON / enums) **is** supported.
- Tools, function calling, grounding, Live API, server prompt templates: not on-device. Live API and server templates are also unsupported for hybrid implementations as a whole.
- `countTokens()` must not be used for routing (counts differ by backend).
- Max **9216 tokens** on-device. Heuristic: ~4 characters/token. `ON_DEVICE_INPUT_BUDGET = 6000` tokens (~24k chars) for document + question, leaving room for the system prompt and output.

---

## 4. Firebase App Check (required)

App Check enforcement for Firebase AI Logic has been required since **2026-11-02**. Missing tokens yield 403s (`PERMISSION_DENIED: To access this model, you must enforce Firebase App Check`). ([App Check for AI Logic](https://firebase.google.com/docs/ai-logic/app-check))

The hackathon FAQ: *Firebase AI Logic requires App Check. Debug tokens are accepted in submissions. Never commit App Check debug tokens, service account keys or .env files to your public repo.*

### 4.1 Console setup (Day 1)

1. Create/select a Firebase project. Google Analytics is optional.
2. Console → **AI Services → AI Logic → Get started**. Choose **Gemini Developer API**.
3. The guided workflow now auto-enforces App Check. Confirm: **Security → App Check → APIs** → row **Firebase AI Logic** is **Enforced**.
4. Leave **replay protection Disabled** for the hackathon (extra latency; limited-use tokens are optional).
5. Register a **Web** app; copy `firebaseConfig`.

### 4.2 Debug provider (extension + localhost)

reCAPTCHA Enterprise does not fit a `chrome-extension://` origin well (domain allow-list + MV3 CSP make the script painful). Official Firebase docs have no first-class "App Check for Chrome extensions" path. For this hackathon, **use the debug provider in the extension**, which the rules explicitly allow.

1. In a **debug / sideload build only**, before `initializeAppCheck`:

   ```ts
   self.FIREBASE_APPCHECK_DEBUG_TOKEN =
     import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
   ```

2. Open the side panel, open DevTools for the panel (right-click the panel → Inspect), read:

   `AppCheck debug token: "123a4567-b89c-12d3-e456-789012345678".`

3. Firebase console → **Security → App Check → Apps** → overflow → **Manage debug tokens** → register it.

4. Put the token in a gitignored `.env.local`:

   ```
   VITE_USE_APPCHECK_DEBUG=true
   VITE_APPCHECK_DEBUG_TOKEN=123a4567-b89c-12d3-e456-789012345678
   ```

5. After that, set the env var to the token string (not `true`) so the token stays stable across profile resets.

**Never** add `localhost` to a production reCAPTCHA key's allowed domains.

### 4.3 Production attestation for the hosted demo

For the Firebase Hosting web demo, register **reCAPTCHA Enterprise** (score-based, checkbox off) on the hosting domain only. Init:

```ts
initializeAppCheck(firebaseApp, {
  provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY),
  isTokenAutoRefreshEnabled: true,
});
```

This is how judges can exercise the **cloud** path without a debug token. The extension demo video uses a machine with a registered debug token that is **not** in the repo. README testing instructions: on-device path works in the sideloaded extension; cloud path is demonstrated in the video and is testable on the hosted demo.

Do not ship a production extension build that embeds a debug token.

### 4.4 `.gitignore` (must)

```
.env
.env.*
!.env.example
*.pem
*serviceAccount*.json
**/firebase-debug.log
```

`.env.example` may list keys with empty values (`VITE_APPCHECK_DEBUG_TOKEN=`). It must not contain real tokens or site keys if you want to be extra safe; the reCAPTCHA *site* key is a public client key and may be committed, the debug token may not.

---

## 5. Manifest, folder layout, and build

### 5.1 Recommended monorepo

```
redact-then-reason/
  LICENSE                          # Apache-2.0
  README.md                        # run instructions, flags, privacy model, how hybrid is used
  package.json                     # pnpm workspace root
  pnpm-workspace.yaml
  .gitignore
  .env.example
  docs/
    ARCHITECTURE.md
    TECH-SPEC.md
    BUILD-PLAN.md
  packages/
    core/                          # reusable ~70%
      package.json                 # name: @rtr/core
      src/
        index.ts
        types.ts
        firebase/init.ts
        firebase/models.ts
        firebase/generate.ts
        redaction/regex.ts
        redaction/luhn.ts
        redaction/extract.ts
        redaction/merge.ts
        redaction/mask.ts
        redaction/unmask.ts
        router/budget.ts
        router/route.ts
        consent/preflight.ts
        prompts/explain.ts
        prompts/draft.ts
        prompts/piiExtract.ts
        # later: prompts/contractGotchas.ts
    extension/                     # MV3 app
      package.json
      vite.config.ts
      manifest.json                # or manifest.ts fed to @crxjs/vite-plugin
      src/
        background.ts              # service worker: panel behavior, menus, injection
        content.ts                 # extract selection / readable text / PDF layer
        sidepanel/index.html
        sidepanel/main.ts
        sidepanel/App.ts(x)        # or vanilla; React/Preact is fine
        sidepanel/styles.css
        lib/sessionStore.ts        # chrome.storage.session wrapper
      public/icons/
    web-demo/                      # hosted paste-text app
      package.json
      vite.config.ts
      src/...
  testdata/                        # synthetic docs only — no real PII
    medical-email.txt
    tax-notice.txt
    hr-benefits.txt
    lease-excerpt.txt              # also used by the stretch entry
```

### 5.2 `manifest.json` (MV3)

```json
{
  "manifest_version": 3,
  "name": "Redact-then-Reason",
  "version": "0.1.0",
  "description": "Explain and reply to sensitive documents on-device. The cloud only ever sees a redacted copy, and only with your consent.",
  "minimum_chrome_version": "139",
  "icons": {
    "16": "public/icons/16.png",
    "48": "public/icons/48.png",
    "128": "public/icons/128.png"
  },
  "action": {
    "default_title": "Redact-then-Reason",
    "default_icon": {
      "16": "public/icons/16.png",
      "48": "public/icons/48.png"
    }
  },
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "background": {
    "service_worker": "src/background.ts",
    "type": "module"
  },
  "permissions": [
    "sidePanel",
    "storage",
    "activeTab",
    "scripting",
    "contextMenus"
  ],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

CRXJS will rewrite TS entry points during build. Do not add a `default_popup` — the action opens the side panel:

```ts
// background.ts
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: "rtr-analyze",
    title: "Analyze with Redact-then-Reason",
    contexts: ["selection", "page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.windowId) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
  // then inject content.ts via chrome.scripting.executeScript and forward text
});
```

### 5.3 Vite + CRXJS sketch (`packages/extension/vite.config.ts`)

```ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { sourcemap: true },
});
```

Load unpacked from `packages/extension/dist`. README should say: Chrome → `chrome://extensions` → Developer mode → Load unpacked.

### 5.4 What to put in README (judges + Stage 1)

- How you used Firebase AI Logic (both `ONLY_ON_DEVICE` and consented `ONLY_IN_CLOUD`), in the repo, not only in Devpost.
- Flags, Chrome 139+, hardware floor.
- Sideload steps, App Check debug setup for *developers* (not a committed token).
- Hosted demo URL and that the cloud path is testable there via reCAPTCHA Enterprise.
- Privacy model: map never leaves the device; consent preview is the exact payload.
- OSS license, English UI.
- No production secrets.

---

## 6. Redaction implementation notes

Keep detectors in `packages/core` with unit tests and a battery of synthetic fixtures. Do not log originals.

**Email:** `\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b` (case-insensitive).

**Phone:** Allow separators and a leading `+`. Post-filter to 10–15 digits. Avoid matching credit-card fragments by running credit-card (Luhn) first and skipping overlaps.

**SSN:** Prefer `\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b`. Unseparated 9-digit only with nearby keywords (`ssn`, `social security`, `itin`, `tin`).

**Credit card:** Strip separators, length 13–19, **Luhn**, then mask. Do not implement IIN databases; Luhn + length is enough.

**Luhn:**

```ts
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}
```

**Merge:** Interval graph, sort by start, longest wins on overlap, regex wins over LLM when the type is a deterministic type (an LLM `OTHER` must not hide an `EMAIL`).

**Tests to write on Day 2–3:** mask/unmask round-trip, Luhn true/false, overlap merge, "payload still contains an email → preflight fails", placeholder reuse for duplicate names, unmask does not interpret `$1` / regex in the original PII.

---

## 7. UI implementation constraints

- Render model output with `textContent` or a sanitized Markdown renderer. **Never `innerHTML`.**
- Stream long answers (`generateContentStream`).
- Show download progress and an honest `unavailable` empty state (link to flags + hardware + the hosted demo).
- The consent modal's preview is the exact outgoing string (ARCHITECTURE §5).
- English UI (submission requirement). A later i18n pass is optional and not MVP.

---

## 8. Disqualification checklist (engineering)

- [ ] `firebase/ai` `getGenerativeModel` + `generateContent` / `generateContentStream` exist in shipped code and run at runtime.
- [ ] App Check is initialized and enforced; no debug token or `.env` in git.
- [ ] No direct calls to other model APIs for inference.
- [ ] Cloud model is `gemini-3.5-flash-lite` (or another billing-not-required 3.x/4.x name), not 2.5.
- [ ] `LICENSE` (Apache-2.0) at repo root; repo public before the deadline.
- [ ] README documents flags, sideload, hosted demo, and the hybrid/privacy design.

---

## 9. Sources

- [Hybrid get-started (Web)](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) — SDK ≥12.5.0, Chrome 139+, flags, `initializeDeviceModel`, 9216-token cap, unsupported features
- [Hybrid configuration options](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options) — modes, `inferenceSource`, `inCloudParams`, `onDeviceParams`, default model `gemini-3.5-flash-lite` as of SDK 13.0.0
- [Structured output (hybrid web)](https://firebase.google.com/docs/ai-logic/hybrid/web/generate-structured-output)
- [JS reference](https://firebase.google.com/docs/reference/js/ai) — `InferenceMode` / `InferenceSource` string values
- [Models](https://firebase.google.com/docs/ai-logic/models) — billing flags, 2.5 auto-route on 2026-12-01, ~4 chars/token
- [App Check for AI Logic](https://firebase.google.com/docs/ai-logic/app-check)
- [App Check debug provider (web)](https://firebase.google.com/docs/app-check/web/debug-provider)
- [reCAPTCHA Enterprise provider (web)](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider)
- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [Chrome + Firebase AI Logic](https://developer.chrome.com/docs/ai/firebase-ai-logic)
- [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Hackathon FAQ](https://firebasehybridaihackathon.devpost.com/details/faqs) — Gemma 4 flag, App Check debug tokens, repo/video rules
- [firebase@13.3.0 release](https://github.com/firebase/firebase-js-sdk/releases/tag/firebase%4013.3.0)
