# Redact-then-Reason — Architecture

A privacy-first Chrome extension (Manifest V3) for Google's #BuildHybridAI 2026 hackathon. This document is the source of truth for component boundaries, data flow, and the consent gate. Implementation details and package versions live in [TECH-SPEC.md](./TECH-SPEC.md). The calendar lives in [BUILD-PLAN.md](./BUILD-PLAN.md).

**Product one-liner:** A sensitive-document assistant for email, patient portals, tax/HR forms, and bills. On-device it detects and redacts PII, explains short documents, and drafts replies fully offline. The cloud only ever receives a redacted copy, and only after explicit user consent, when a document is long or a question is hard. The 🔒 / ☁️ control is a real privacy gate, not a badge.

---

## 1. Hard design rule (read this first)

**Never call Firebase AI Logic in `PREFER_ON_DEVICE` or `PREFER_IN_CLOUD` mode with raw (unredacted) document text.**

Those modes automatically fall back to the cloud when Gemini Nano is missing, still downloading, or cannot handle the request. An automatic fallback would send medical, tax, or HR text off-device without consent — the opposite of this product.

Use explicit modes instead, chosen by our router (not by the SDK's automatic fallback):

| Task | Mode | Payload |
|---|---|---|
| PII detection / extraction | `InferenceMode.ONLY_ON_DEVICE` | Raw text (stays on device) |
| Explain / draft on a short or "easy" doc | `InferenceMode.ONLY_ON_DEVICE` | Raw or redacted text (stays on device) |
| Consented cloud reasoning | `InferenceMode.ONLY_IN_CLOUD` | **Redacted text only**, after the user clicks Send |

`result.response.inferenceSource` (`InferenceSource.ON_DEVICE` = `"on_device"`, `InferenceSource.IN_CLOUD` = `"in_cloud"`) still drives the visible 🔒 / ☁️ badge so judges can see which path ran. If a call ever returns `in_cloud` for a request that was supposed to be on-device only, treat it as a bug and do not display the model output.

Sources: [Inference modes](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options), [inferenceSource](https://firebase.google.com/docs/reference/js/ai#inferencesource).

---

## 2. Component diagram

All AI inference runs in the **side panel page**, not in the service worker. The panel is a real extension document: it has a DOM, user gestures (required to call `initializeDeviceModel()`), and it stays open while the user works. The service worker is only a router.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome tab (untrusted page)               │
│  Gmail / patient portal / IRS / HR / bill / PDF viewer           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Content script (injected on user gesture only)             │ │
│  │  • selection, or readable body text, or PDF.js text layer  │ │
│  │  • never runs Firebase, never holds the placeholder map    │ │
│  └─────────────────────────────┬──────────────────────────────┘ │
└────────────────────────────────┼────────────────────────────────┘
                                 │ chrome.runtime.sendMessage
                                 │ { type: "PAGE_TEXT", text, url, title }
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Service worker (MV3 background)                                  │
│  • open side panel on action click / context menu                │
│  • inject content script via chrome.scripting (activeTab)        │
│  • forward PAGE_TEXT to the side panel                           │
│  • no Firebase AI Logic, no raw-PII storage                      │
└─────────────────────────────┬───────────────────────────────────┘
                              │ runtime messaging / ports
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Side panel UI  (sidepanel.html — the AI runtime + consent UX)    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐ │
│  │ Capture pane │  │ Redaction preview│  │ Explain / Draft /  │ │
│  │ paste, page, │  │ typed placeholders│  │ Ask + 🔒/☁️ badge  │ │
│  │ selection    │  │ [EMAIL_1] [SSN_1]│  │ + consent modal    │ │
│  └──────┬───────┘  └────────┬─────────┘  └─────────┬──────────┘ │
│         │                   │                      │            │
│         ▼                   ▼                      ▼            │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Core engine (shared package, reusable by Contract Gotcha)  │ │
│  │                                                            │ │
│  │  Text intake ──► Redaction engine ──► Router / consent     │ │
│  │                      │                      │              │ │
│  │                      │                      ▼              │ │
│  │                      │              Firebase AI Logic      │ │
│  │                      │              wrapper (ONLY_*)       │ │
│  │                      ▼                      │              │ │
│  │              Local placeholder store        │              │ │
│  │              (chrome.storage.session)       │              │ │
│  │                      ▲                      │              │ │
│  │                      └──── unmask output ◄──┘              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Firebase AI Logic (this document, after user click):            │
│    initializeApp  →  App Check  →  getAI(GoogleAIBackend)        │
│    → getGenerativeModel(..., { mode: ONLY_ON_DEVICE |            │
│                                       ONLY_IN_CLOUD })           │
│    → initializeDeviceModel() on first gesture                    │
│    → generateContent / generateContentStream                     │
└─────────────────────────────────────────────────────────────────┘
```

### Why this layout (and what we are not doing)

| Option | Verdict |
|---|---|
| **Side panel as AI host** | **Chosen.** Persistent, has user activation, official Prompt API support, natural place for consent UI. Open via toolbar click (`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`). See [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel). |
| Popup | Too ephemeral. Closes when the user clicks the page, which is exactly when they need the assistant. Keep the toolbar action tied to the side panel, not a popup. |
| Service worker as AI host | Do **not** run `initializeDeviceModel()` / Firebase AI Logic here. Firebase requires a user gesture before initializing the on-device model ([get-started, Step 6](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)). A worker has no click. The Chrome Prompt API can run in a service worker *after* the model is already downloaded, but the first download must start from a panel/page gesture. Keeping all inference in the panel avoids a split brain. |
| Offscreen document | Not needed for MVP. Only revisit if we must run inference while the panel is closed. Offscreen documents also lack a user gesture. |
| Always-on content script on `<all_urls>` | Avoid. Inconsistent with a privacy product, and unnecessary. Inject on a click ("Analyze this page") with `activeTab` + `scripting`. Request `optional_host_permissions: ["<all_urls>"]` only if we add a context menu that must work before the user has granted the tab. |

---

## 3. Component responsibilities

### 3.1 Content script (ephemeral, untrusted page)

Injected by the service worker on a user gesture. It may:

- Return `window.getSelection().toString()` if the user highlighted text.
- Otherwise return a readable text extract: prefer a simple "main content" trim (drop `nav`, `footer`, `aside`, `script`, `style`) over raw `document.body.innerText`.
- For Chrome's built-in PDF viewer, scrape the PDF.js text layer (`.textLayer`) if present. **Do not send PDF bytes to the on-device model** — on-device multimodal document/PDF input is not supported and would fall back or throw ([unsupported features](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)).
- Optional later: site-specific selectors for Gmail / Outlook as progressive enhancement, behind the same interface.

It must not import Firebase, must not call any model, and must not persist text.

### 3.2 Service worker

- On install: `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
- Context menu: "Analyze with Redact-then-Reason" → `sidePanel.open({ windowId })` then inject and forward text.
- Message router: `GET_TAB_TEXT`, `PAGE_TEXT`, `OPEN_PANEL`.
- No AI, no placeholder map, no App Check.

### 3.3 Side panel UI

The only surface that talks to Firebase AI Logic.

**States to implement as a state machine, not ad-hoc flags:**

`idle` → `capturing` → `redacting` → `ready` → (`explaining` \| `drafting` \| `awaiting_consent`) → `cloud_running` → `done` / `error`

Plus a global `model` substate: `unknown` | `downloadable` | `downloading(progress)` | `available` | `unavailable`.

**Always-visible chrome:**

- 🔒 On-device / ☁️ Cloud badge, bound to the last `inferenceSource` (and to "pending consent" when the cloud path is offered but not yet sent).
- Nano availability + download progress from `initializeDeviceModel((p) => ...)`.
- A one-line privacy status: "Nothing has left this device" or "Sent N characters of redacted text to Firebase AI Logic (Gemini cloud). The placeholder map stayed here."

**Consent modal (the gate):** shown before any `ONLY_IN_CLOUD` call. See §5.

### 3.4 Redaction engine (shared core)

Pipeline, always on-device, in this order:

1. **Deterministic detectors (regex + validators)** run first. These are the source of truth for well-structured identifiers. Gemini Nano is not reliable enough alone for SSN, PAN, email, or phone.
2. **On-device LLM extraction** (`ONLY_ON_DEVICE` + structured JSON output) finds names, street addresses, organizations, medical-record-style IDs, and other entities regex will miss.
3. **Merge** detections, drop overlaps (longest span wins), assign typed, stable placeholders.
4. **Mask** the text. Keep a local `PlaceholderMap`.
5. **Never** send the map, the raw text, or a reversible encoding off-device.

#### Deterministic types (must implement for MVP)

| Type | Placeholder | Detector notes |
|---|---|---|
| `EMAIL` | `[EMAIL_N]` | RFC-ish email regex; lowercase for dedup. |
| `PHONE` | `[PHONE_N]` | NANP and international (`+` + 8–15 digits), allow separators. |
| `SSN` | `[SSN_N]` | `\b\d{3}-\d{2}-\d{4}\b` and unseparated `\b\d{9}\b` only when nearby context looks like SSN/TIN (to avoid zip+order ids). Never keep the raw value in logs. |
| `CREDIT_CARD` | `[CREDIT_CARD_N]` | 13–19 digits with optional spaces/dashes, **Luhn check required**. |
| `DOB` / `DATE` | `[DOB_N]` / `[DATE_N]` | Mark as `DOB` when adjacent to dob/birth/born; otherwise `DATE` only in "sensitive doc" mode (default on). |
| `ACCOUNT` | `[ACCOUNT_N]` | Long digit runs (9–17) that failed Luhn and SSN context. |
| `IP` | `[IP_N]` | IPv4. |
| `MRN` | `[MRN_N]` | Patterns near "MRN", "medical record", "member ID". |

#### LLM-extracted types (on-device structured output)

`PERSON`, `ORG`, `ADDRESS`, plus any leftover `MRN` / `ACCOUNT` the regex pass missed.

Schema (plain JSON Schema, also expressible with Firebase `Schema` helpers — configure **both** `onDeviceParams.promptOptions.responseConstraint` and, if this model instance is ever reused, `inCloudParams.generationConfig.responseSchema`. For this pass the model is `ONLY_ON_DEVICE`, so the on-device constraint is what matters):

```json
{
  "type": "object",
  "properties": {
    "entities": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["PERSON", "ORG", "ADDRESS", "MRN", "ACCOUNT", "OTHER"] },
          "text": { "type": "string" },
          "start": { "type": "integer" },
          "end": { "type": "integer" }
        },
        "required": ["type", "text"]
      }
    }
  },
  "required": ["entities"]
}
```

Prompt the model to return exact substrings from the source (no paraphrased names). After parse, **verify each `text` actually occurs in the source** before masking; drop hallucinations. Use character offsets if present and consistent; otherwise `indexOf` from a moving cursor.

Nano will miss some entities and will occasionally over-tag. The regex pass covers the high-liability identifiers; the LLM pass is a recall boost, not the safety floor.

#### Placeholder map

```ts
type EntityType =
  | "EMAIL" | "PHONE" | "SSN" | "CREDIT_CARD" | "DOB" | "DATE"
  | "ACCOUNT" | "IP" | "MRN" | "PERSON" | "ORG" | "ADDRESS" | "OTHER";

interface PlaceholderEntry {
  token: string;       // "[EMAIL_1]"
  type: EntityType;
  original: string;    // raw PII, in memory / session store only
  start: number;
  end: number;
}

interface PlaceholderMap {
  docId: string;
  createdAt: number;
  entries: PlaceholderEntry[]; // token is unique
}
```

- Apply replacements from **end of string to start** so offsets stay valid.
- Identical originals of the same type reuse the same token (`Jane Doe` is always `[PERSON_1]` in that document).
- Store the map in `chrome.storage.session` (cleared when the browser closes). Never `local` or `sync`. Clear explicitly on "New document".
- The map never crosses the network, never goes into a prompt, never gets logged.

#### Unmasking cloud (or on-device) output

1. The prompt must say: "Placeholders look like `[TYPE_N]`. Copy them verbatim. Do not invent values for them."
2. Replace only exact tokens from the map (`split`/`replaceAll` on the full token string, not regex with user text).
3. After unmasking, scan the output with the same email / SSN / Luhn detectors. If a detector hits a string that was **not** just substituted from the map, treat it as possible model-invented or leaked PII: do not show the raw match; show a warning and a `[REDACTED_SUSPECT]` stand-in. Cloud models can hallucinate identifiers or try to "fill in" a name.

### 3.5 Firebase AI Logic wrapper (shared core)

One module, two model instances (do not reuse a single instance across modes — config is per instance):

- `onDeviceModel` — `InferenceMode.ONLY_ON_DEVICE`
- `cloudModel` — `InferenceMode.ONLY_IN_CLOUD` with `inCloudParams.model = "gemini-3.5-flash-lite"`

Responsibilities: App Check init, `initializeDeviceModel()` after a click, download progress, availability probe via `LanguageModel.availability()`, `generateContent` / `generateContentStream`, returning `{ text, inferenceSource }`. See TECH-SPEC for exact snippets.

**Do not call the Chrome `LanguageModel` API directly for product inference.** The hackathon requires all AI inference to go through Firebase AI Logic. `LanguageModel.availability()` is allowed as a *status probe* (it is not inference). Do not `LanguageModel.create()` / `session.prompt()` in product code.

### 3.6 Router

After redaction:

```
if nano is unavailable AND user has not consented to cloud:
    offer consent (or explain that on-device is unavailable)
    do not silently call the cloud

if estimateTokens(redacted + question + system) <= ON_DEVICE_INPUT_BUDGET
   AND question is not flagged hard:
    run ONLY_ON_DEVICE on the raw or redacted text
    (raw is allowed: it never leaves the device)
    if the on-device call throws: offer consent, do not auto-fallback

else:
    open the consent modal with the redacted payload preview
    wait for an explicit "Send redacted text to cloud" click
    then ONLY_IN_CLOUD(redacted_text, question)
    unmask locally
```

**Token budget.** On-device max is **9216 tokens** ([get-started](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)). Do **not** use `countTokens()` for routing — Firebase documents that token counts differ between on-device and cloud, so there is no intuitive hybrid fallback ([unsupported hybrid features](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)). Use the documented heuristic: **~4 characters ≈ 1 token**. Reserve ~2,000 tokens for the system prompt and output. **`ON_DEVICE_INPUT_BUDGET = 6000` tokens ≈ 24,000 characters** of document + question.

**"Hard" question heuristic (any one is enough to offer cloud, not to auto-send):**

- Input estimate exceeds `ON_DEVICE_INPUT_BUDGET`.
- User clicked "Use cloud for a deeper answer".
- Question matches comparison / multi-hop / "list every … / find all inconsistencies / compute" patterns.
- On-device call failed or returned an empty/blocked response.

**Chunking for redaction of long docs.** Split on paragraph boundaries with a ~200-character overlap so entities at boundaries are not missed. Run deterministic detectors on the full text (cheap). Run the on-device LLM extractor per chunk if a chunk exceeds ~3,000 tokens, then merge. Reasoning on the full raw long doc is out of budget — either summarize-on-device chunk-by-chunk (MVP stretch) or take the consented cloud path with the **full redacted** document (cloud input limit is 1,048,576 tokens on `gemini-3.5-flash-lite`).

### 3.7 Local placeholder store

`chrome.storage.session`, keyed by `docId`. In-memory `Map` is the working copy; session storage is the refresh safety net while the panel is open. Wiped on "New document", on browser close, and never written to disk beyond session.

---

## 4. Data flows

### 4.1 On-device-only path (default)

```
User opens panel (toolbar click)
  → initializeDeviceModel() starts / reports download progress
User clicks "Analyze this page" or pastes text
  → SW injects content script (if page) → text arrives in panel
Redaction engine (regex + ONLY_ON_DEVICE structured extract)
  → preview of masked text + counts by type
  → map stored in chrome.storage.session
User clicks Explain or Draft reply
  → router: short + easy → ONLY_ON_DEVICE(generateContentStream)
  → badge = 🔒 on_device
  → unmask any placeholders in the answer (usually none if we sent raw)
  → status: "Nothing has left this device"
```

No network call to `firebasevertexai.googleapis.com` is made for this path. (App Check / Firebase init may touch the network at startup; document text does not.)

### 4.2 Redacted-cloud path (opt-in)

```
Same capture + on-device redaction as 4.1
Router decides the doc is long or the question is hard
  → CONSENT GATE (modal) — see §5
  → user reviews the exact redacted payload
  → user clicks "Send redacted text to cloud"  (Cancel is the default action)
ONLY_IN_CLOUD(redacted document + question + "preserve placeholders")
  → badge = ☁️ in_cloud
  → unmask tokens locally
  → suspect-PII scan on the output
  → status: "Sent N characters of redacted text. The placeholder map stayed on this device."
```

If the user refuses consent, stay on-device: explain what can be done locally (chunked summary, shorter question), or stop.

### 4.3 What never happens

- Raw document text in an `ONLY_IN_CLOUD`, `PREFER_ON_DEVICE`, or `PREFER_IN_CLOUD` request.
- The placeholder map in any request body, log, or analytics event.
- Multi-turn `startChat()` on the on-device model — **multi-turn chat is not supported on-device** and `PREFER_ON_DEVICE` would silently fall back to the cloud ([unsupported on-device features](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)). Follow-ups are new single-turn prompts that include a short local summary of prior Q&A, or a fresh consented cloud turn on redacted text.
- Direct calls to the Gemini Developer API, Vertex, OpenAI, or `LanguageModel.prompt()` for product features.

---

## 5. Consent gate (exact placement)

The gate sits **after redaction and before any `ONLY_IN_CLOUD` call**. It is the only path that may touch the network with document content.

**Required modal contents:**

1. Title: "Send a redacted copy to the cloud?"
2. One sentence: the original stays on this device; only the masked text below will be sent to Firebase AI Logic (Gemini cloud) to answer a harder or longer request.
3. **Scrollable preview of the exact string that will be sent** (redacted document + the user's question). This is not a summary of the preview — it is the payload.
4. Counts: e.g. "12 names, 3 emails, 1 SSN masked. 0 unmasked emails/SSNs detected in the outgoing text." (Run the deterministic detectors on the payload and refuse to send if any still match.)
5. Destination disclosure: "Firebase AI Logic / Gemini Developer API. The placeholder map is not included."
6. Buttons: **Cancel** (default, focused) and **Send redacted text to cloud**.
7. Optional checkbox, unchecked: "Also allow cloud for hard questions in this session" — still show the preview the first time; subsequent times can use a slimmer confirm if this is checked. Never a hidden standing "always cloud" toggle that skips the preview entirely.

**Pre-flight checks before enabling Send:**

- Outgoing text still passes the email / SSN / Luhn detectors (zero hits).
- App Check initialized (cloud calls will 403 otherwise).
- User gesture is the Send click itself.

The 🔒 / ☁️ control in the header reflects state; it does not bypass the modal. Clicking ☁️ on a ready document opens the same gate rather than sending immediately.

---

## 6. Permissions and trust boundary

Recommended `manifest.json` permissions (see TECH-SPEC for the full file):

- `sidePanel`, `storage`, `activeTab`, `scripting`, `contextMenus`
- `optional_host_permissions`: `["<all_urls>"]` (requested only when needed)

The web page is untrusted. Content-script text is treated as data, never as HTML (`textContent` only — Chrome's own [built-in AI guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/built-in-ai/language-model) says never assign model output to `innerHTML`). Model output is untrusted too.

---

## 7. Hosted web demo (strongly encouraged)

Judges are not required to sideload the extension and may score from the video + writeup alone, but a hosted URL is strongly encouraged ([hackathon FAQ](https://firebasehybridaihackathon.devpost.com/details/faqs)).

Ship a Firebase Hosting (or similar) paste-text web app that imports the **same core package** (redaction, router, Firebase wrapper, consent modal). This is also the path where **reCAPTCHA Enterprise App Check** works cleanly for strangers, including judges testing the cloud path. The extension itself should use the App Check debug provider (hackathon-accepted); see TECH-SPEC § App Check.

---

## 8. Reuse for "Contract Gotcha-highlighter" (~70%)

Keep these in `packages/core` with no product-specific UI:

- Deterministic + LLM redaction pipeline and placeholder store
- Firebase AI Logic wrapper and availability / download UX helpers
- Consent gate primitives (preview, pre-flight detectors, Send/Cancel)
- Router and token-budget heuristic
- Text intake types (`CapturedDoc`)

Swap only:

- Prompts and output schema (explain/draft vs. "flag fees, auto-renew, arbitration, early-termination, addenda")
- Side-panel copy and visual treatment
- Optional clause highlighters in the preview

Do not fork the Firebase or redaction layers.

---

## 9. Disqualification / eligibility landmines

These will fail Stage 1 (pass/fail) or violate the FAQ. Full list and owners are in BUILD-PLAN.md.

| Risk | Rule |
|---|---|
| AI inference not going through Firebase AI Logic | All `generateContent` / `generateContentStream` calls must use `getGenerativeModel` from `firebase/ai`, imported and actually executed at runtime — not just mentioned in the README. No direct Gemini / OpenAI / `LanguageModel.prompt()` product calls. |
| App Check missing | Firebase AI Logic requires App Check (enforced since Nov 2, 2026). Debug tokens are accepted in submissions. **Never commit** debug tokens, service-account keys, or `.env` files. |
| Wrong / missing hybrid story | Judges score how effectively you use both on-device and cloud. A cloud-only app is a weak entry; an on-device-only app that never shows a consented cloud path also undersells hybrid. Demo both paths in the first 30 seconds of the video. |
| Automatic cloud fallback on raw PII | Functional and ethical failure, and it undermines the idea score. Use `ONLY_*` modes as in §1. |
| Repo not public, no OSS license file | GitHub/GitLab must be public with a license file (Apache-2.0 preferred) visible in About. |
| Video > 3 minutes, not public, not English | Only the first 3 minutes may be judged. Upload early (processing delay). English or English subtitles. Show the project working in Chrome. |
| Gemini 2.5 cloud model | Do not pin `gemini-2.5-flash` / `Pro`. Starting Dec 1, 2026 those names auto-route and may break. Use `gemini-3.5-flash-lite` (billing not required; SDK default from v13.0.0). |
| Image / TTS models | Billing-required. Not needed. Skip the quota form unless the plan changes. |

---

## 10. Sources

- [Understanding hybrid inference (Firebase blog, Oct 2025)](https://firebase.blog/posts/2025/10/understand-ai-logic-hybrid-inference/)
- [Build hybrid experiences — Web get-started](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) (updated 2026-11-12)
- [Hybrid configuration options (modes, inferenceSource, inCloudParams, onDeviceParams)](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options)
- [Structured output for hybrid web](https://firebase.google.com/docs/ai-logic/hybrid/web/generate-structured-output)
- [Firebase AI JS reference — InferenceMode / InferenceSource](https://firebase.google.com/docs/reference/js/ai)
- [App Check for Firebase AI Logic](https://firebase.google.com/docs/ai-logic/app-check)
- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (updated 2026-10-21)
- [Chrome + Firebase AI Logic](https://developer.chrome.com/docs/ai/firebase-ai-logic)
- [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [#BuildHybridAI 2026 FAQs](https://firebasehybridaihackathon.devpost.com/details/faqs) and [Rules](https://firebasehybridaihackathon.devpost.com/rules)
- [Supported models](https://firebase.google.com/docs/ai-logic/models)
