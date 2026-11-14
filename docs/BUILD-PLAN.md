# Redact-then-Reason — 16-day build plan

Deadline: **Monday, November 30, 2026, 5:00 PM America/New_York** (2:00 PM PT). The deadline is fixed; drafts lock; commits after the deadline are not evaluated. Upload the YouTube video early — processing can take hours. ([FAQ](https://firebasehybridaihackathon.devpost.com/details/faqs))

Today is Saturday, November 14, 2026. This plan uses **today through Sunday, November 29** for build and a **Monday morning buffer** for the Devpost submit. Do not plan to start the video or the submission form on Monday afternoon.

Companion docs: [ARCHITECTURE.md](./ARCHITECTURE.md), [TECH-SPEC.md](./TECH-SPEC.md).

---

## 0. Non-negotiables before writing product code

Do these on Day 1 even if the UI is still a stub.

1. **Join the hackathon** on [Devpost](https://firebasehybridaihackathon.devpost.com/) if not already registered.
2. Create the Firebase project, run **AI Services → AI Logic → Get started**, pick **Gemini Developer API**, confirm App Check is **Enforced** for Firebase AI Logic.
3. Create a **public** GitHub repo with `LICENSE` (Apache-2.0) from the first commit. Do not wait until submit day.
4. Chrome 139+ on Darlikk, enable flags, restart, confirm `LanguageModel.availability()` is not `unavailable`.
5. A throwaway side-panel page that: inits Firebase + App Check (debug token, gitignored), calls `initializeDeviceModel()` on a button, then `ONLY_ON_DEVICE` `generateContent("Say hello in five words")` and shows `inferenceSource`. This proves the stack before any redaction work. **If this stub does not call `firebase/ai` at runtime, the repo is already ineligible.**

---

## 1. MVP vs polish vs stretch

### MVP (must be demoable by Thursday, November 26)

The video can be shot from this list alone:

- Sideloadable MV3 extension, side panel opens from the toolbar icon.
- Capture: current-tab text (user click), selection, or paste.
- On-device PII detect + redact (regex + Luhn + on-device structured extract) with typed placeholders and a preview.
- Explain a short sensitive doc **on-device** (`ONLY_ON_DEVICE`), streamed into the panel.
- Draft a short reply **on-device**.
- Consent modal (exact payload preview, pre-flight detectors, Cancel / Send) then **`ONLY_IN_CLOUD`** on the redacted text only.
- 🔒 / ☁️ badge bound to `inferenceSource`, plus a one-line "what left the device" status.
- Nano download progress and an honest `unavailable` state.
- App Check in place (debug in the extension, no secrets in git).
- Synthetic fixture docs (medical email, tax notice, HR letter) — **no real PII**.
- README + Apache-2.0 LICENSE + public repo with Firebase AI Logic actually called.
- Hosted paste-text demo on Firebase Hosting (same core), reCAPTCHA Enterprise for App Check, so judges can try the cloud path.

### Polish (November 27–29, in priority order)

- Consent-modal typography, payload diff ("12 names, 3 emails masked"), session "allow cloud for hard questions" checkbox.
- Site-specific extractors for Gmail / Outlook (progressive enhancement).
- PDF.js text-layer extraction.
- Suspect-PII scan on model output.
- Keyboard shortcut to open the panel / analyze selection.
- Visual design pass (light/dark, motion on the badge, empty states). Keep it calm and trustworthy, not playful-toy.
- README screenshots, a 30-second "how hybrid works" section, testing instructions.
- Optional: Remote Config for `ON_DEVICE_INPUT_BUDGET` and the cloud model name (encouraged by the brief; not required).

### Stretch — Contract Gotcha-highlighter (only if MVP is solid on November 26)

A second, substantially different Devpost submission is allowed. Do **not** start it before the main entry can be filmed.

- New `packages/extension-gotcha` (or a mode toggle *only if* you decide to keep a single extension — prefer a second extension + second repo or a clearly separate package so the submissions stay "substantially different").
- Reuse `@rtr/core` (redaction, Firebase wrapper, consent, router). New prompts/schema: fees, auto-renew, arbitration, early termination, addenda, "what happens if I cancel."
- One extra fixture: a synthetic lease excerpt.
- Only film a second video if the first is already uploaded and the Devpost form for entry #1 is a complete draft.

If time is tight, ship one excellent entry.

---

## 2. Day-by-day calendar

All times below are **America/New_York**.

### Weekend 1 — foundation

**Sat Nov 14 (Day 1) — Register, project, stub**

- Join Devpost. Create Firebase project + AI Logic + App Check enforced. Register a Web app.
- Enable Chrome flags; verify Nano availability on Darlikk.
- `pnpm` monorepo: `packages/core`, `packages/extension`, `packages/web-demo`. Apache-2.0. `.gitignore` as in TECH-SPEC. Public GitHub repo.
- Side-panel stub: App Check debug token (gitignored) + `initializeDeviceModel` + on-device "hello" + `inferenceSource` on screen.
- Draft a 1-page Devpost blurb so the "how we use Firebase AI Logic" text is not written at 4 pm on the 30th.

**Sun Nov 15 (Day 2) — Redaction core, no UI polish**

- Implement regex + Luhn detectors with unit tests and `testdata/` fixtures.
- Placeholder map, mask, unmask, overlap merge, pre-flight "payload must not still contain an email/SSN/PAN."
- Session store wrapper (`chrome.storage.session`).
- Hook paste-into-panel → redact → preview (can be ugly).

### Week 1 — product path

**Mon Nov 16 (Day 3) — On-device LLM extract + explain**

- `piiModel` with structured output, `ONLY_ON_DEVICE`. Verify spans against the source.
- Merge regex + LLM entities.
- Explain-short-doc prompt + `generateContentStream` in the panel. Badge = 🔒.

**Tue Nov 17 (Day 4) — Draft reply + capture from the page**

- Draft-reply prompt (on-device, single-turn).
- Service worker: `openPanelOnActionClick`, context menu, `scripting.executeScript` for selection / readable body.
- End-to-end: open Gmail-like fixture HTML or a local `testdata` page → Analyze → explain.

**Wed Nov 18 (Day 5) — Router + consent + cloud**

- Token-budget heuristic and "hard question" rules (ARCHITECTURE §3.6).
- Consent modal with **exact payload preview**. Pre-flight detectors must block Send on leakage.
- `ONLY_IN_CLOUD` on redacted text; unmask in the panel; badge = ☁️; status line.
- **Stop and dogfood:** a synthetic medical email, short (on-device) and long (consent + cloud). Confirm in DevTools Network that the cloud request body has placeholders and no raw emails/SSNs.

**Thu Nov 19 (Day 6) — Hosted demo + App Check for judges**

- `packages/web-demo` paste-text UI on Firebase Hosting, same `@rtr/core`.
- reCAPTCHA Enterprise on the hosting domain (not localhost). Confirm a cold browser can complete the cloud path.
- README: flags, sideload, demo URL, privacy model, "how hybrid works."

**Fri Nov 20 (Day 7) — Hardening the engine**

- Chunking for long-doc PII extraction (overlap, merge).
- Follow-up questions as new single-turn prompts (no on-device `startChat`).
- Output suspect-PII scan.
- Availability / download / 403 App Check error states that a judge would actually hit.

**Sat Nov 21 (Day 8) — UX pass 1**

- State machine in the panel (ARCHITECTURE §3.3). No illegal transitions (e.g. cloud send from `redacting`).
- Badge, progress, empty states, `textContent`-only rendering.
- Three polished synthetic fixtures and a "Load sample" menu for the video.

**Sun Nov 22 (Day 9) — Buffer / catch-up**

- Slip day for whatever broke (Nano download, App Check, extraction quality).
- If on track: Gmail/Outlook selectors or PDF text layer — one of them, not both if either is messy.

### Week 2 — polish, tape, submit

**Mon Nov 23 (Day 10) — Quality bar**

- Redaction quality sweep on all fixtures; tune prompts, not architecture.
- Accessibility: focus in the consent modal, contrast, keyboard.
- Confirm no secrets in git (`git log` / `rg` for token-shaped strings).

**Tue Nov 24 (Day 11) — Feature freeze for MVP**

- Bug fixes only on the main path after 5:00 PM ET.
- Write the Devpost description (how Firebase AI Logic is used, features, value proposition, audience). English.
- Outline the demo video (see §4). First 30 seconds = idea + hybrid + both badges on screen.

**Wed Nov 25 (Day 12) — Record and upload a draft video**

- Record a tight 2:00–2:30 walkthrough (leave margin under 3:00).
- Upload to YouTube the same day (public or unlisted — must be reachable from the form without a sign-in wall; the FAQ says "uploaded publicly"). Prefer **public** or **unlisted**, never private.
- If the cut is rough, you still have the processing started and can replace the file later.

**Thu Nov 26 (Day 13) — MVP complete checkpoint**

- Sideload on a clean Chrome profile (or second profile) following only the README. Fix anything the README skipped.
- Fill the Devpost form as a **saved draft**: platform = Web (Chrome), repo URL, demo URL, video link, description.
- Decision point: if MVP is solid and energy remains, start Contract Gotcha in the evening. Otherwise keep polishing entry #1.

**Fri Nov 27 (Day 14) — Polish or stretch**

- Main entry: design polish, README screenshots, any README-only judge friction.
- Stretch (optional): gotcha prompts + second package + lease fixture. Do not cannibalize video or submit work.

**Sat Nov 28 (Day 15) — Final video + repo tidy**

- Re-record the video if the Thursday cut missed the consent preview or the 🔒→☁️ transition.
- Confirm license file, public repo, no `.env`, `firebase/ai` calls visible in `packages/core`.
- Tag a release (`v1.0.0-hackathon`) so the judged commit is obvious. Do not force-push after this tag.

**Sun Nov 29 (Day 16) — Submit**

- Click **Submit** on Devpost **today**, not on Monday. Recheck every required field (port-field / category quirks have already bitten us once).
- Confirm the video is playable incognito, the repo is public, the hosted demo loads, the license is visible.
- Leave Monday for emergencies only (YouTube processing, a typo on the form). No new features on the 30th.

**Mon Nov 30 — Emergency buffer only. Hard stop 5:00 PM ET.**

---

## 3. Workstream split (for coding agents)

Run these in parallel when possible. A single agent should not "design the architecture" again — it is already in these docs.

| Stream | Owner style | Starts | Done when |
|---|---|---|---|
| A. Firebase stub + App Check + Hosting | Someone who will click the console | Nov 14 | Hello-on-device works; Hosting + reCAPTCHA demo on Nov 19 |
| B. `@rtr/core` redaction + tests | Backend-heavy | Nov 15 | Fixtures mask/unmask; preflight catches leaks |
| C. Extension shell (SW, panel, capture) | MV3-fluent | Nov 14–17 | Analyze this page → text in the panel |
| D. Router + consent + cloud wiring | Same as B or C | Nov 18 | Dogfood Network tab is clean |
| E. UI polish | Design-sensitive | Nov 21, 23, 27 | Badge, modal, samples, a11y |
| F. Video + Devpost + README | Human + agent | Nov 24–29 | Submitted Nov 29 |

Agents must not: add `PREFER_ON_DEVICE` on raw text, call `LanguageModel.prompt()` for product features, commit `.env` or debug tokens, introduce Gemini 2.5 model names, or add analytics that upload document text.

---

## 4. Demo video outline (≤ 3:00, first 30 seconds sell the idea)

Judges may score from the video alone. Cynthia Jiang's guidance: the first 30 seconds should say who it's for, the problem, and how Firebase AI Logic makes it work. Show hybrid features working early.

Suggested cut (~2:15):

| Time | Shot |
|---|---|
| 0:00–0:20 | Problem: a medical bill / HR email is sitting in the tab. You want help. You do not want that text in the cloud. |
| 0:20–0:30 | "Redact-then-Reason uses Firebase AI Logic: Gemini Nano on-device for private work; cloud only sees a redacted copy, and only if I say so." |
| 0:30–0:50 | Toolbar → panel. 🔒 badge. On-device model ready (or a brief download-progress clip if it's a fresh profile — optional). |
| 0:50–1:20 | Analyze the sample medical email. Redaction preview: names, emails, MRN become `[PERSON_1]`, `[EMAIL_1]`, `[MRN_1]`. |
| 1:20–1:45 | Click Explain. Streamed on-device answer. Badge stays 🔒. Status: "Nothing has left this device." |
| 1:45–2:10 | Paste a longer tax notice or ask a hard question. Consent modal shows the **exact redacted payload**. Point at the placeholders. Click Send. Badge flips to ☁️. Unmasked answer appears. Status line names Firebase AI Logic. |
| 2:10–2:15 | Close: the map never left the machine. Link to the repo and hosted demo. |

No third-party logos you don't have rights to. English narration or English subtitles. Do not go over 3:00.

---

## 5. Keeping ~70% reusable for Contract Gotcha

Already designed in ARCHITECTURE §8. Practical rules for agents:

- No product strings or lease-specific types inside `packages/core/src/firebase` or `redaction`.
- Prompts live in `packages/core/src/prompts/*` as named exports, or in the extension package if they are product-specific. Prefer the latter for gotcha-only prompts so core stays generic.
- The consent modal should accept title / body copy as props so the second extension can restyle without forking the pre-flight logic.
- If a second submission happens, it needs its own Devpost project, its own video, and a description that is clearly a different product (contract clauses vs. sensitive-doc assistant), even though the engine is shared. Disclose the shared core in both READMEs.

---

## 6. Disqualification and eligibility checklist

Stage 1 is pass/fail on requirements. Walk this list on Nov 23 and again on Nov 29 before clicking Submit.

### Will disqualify or fail Stage 1

| # | Requirement | How we comply |
|---|---|---|
| 1 | All AI inference goes through Firebase AI Logic, imported and **called at runtime** (not just named in the README) | Only `getGenerativeModel` + `generateContent` / `generateContentStream` from `firebase/ai`. No OpenAI, no raw Gemini HTTP, no `LanguageModel.prompt()` in product code. |
| 2 | App Check required; debug tokens OK; **never commit** debug tokens, service-account keys, or `.env` | Enforced in console. Debug token only in gitignored `.env.local`. Hosted demo uses reCAPTCHA Enterprise. |
| 3 | Public GitHub or GitLab with an OSS license file (Apache preferred) | `LICENSE` Apache-2.0 at root from Day 1; repo public. |
| 4 | Repo contains source, assets, and run instructions | README with flags, sideload, demo URL. |
| 5 | Video ≤ 3 minutes, reachable, English or English subtitles, shows the project working on Chrome | Record Nov 25, public or unlisted (not private), first 30s = idea + hybrid. |
| 6 | App supports English; submission materials in English | UI + Devpost + video. |
| 7 | Built for Web (Chrome) with Gemini Nano 4 via Firebase AI Logic | Extension + flags documented. |
| 8 | Entrant eligibility (age, residency, not a Google/Devpost employee, etc.) | Victor confirms; agents do not submit if he is ineligible. |

### Will not formally disqualify, but will lose the judging room

| Risk | Mitigation |
|---|---|
| Cloud-only, or on-device-only with no consented cloud demo | Film both paths in the first two minutes. |
| `PREFER_ON_DEVICE` leaking raw PII to the cloud | Forbidden in ARCHITECTURE §1. Code review for `InferenceMode.PREFER_*`. |
| Generic summarizer (Firebase's own tutorial shape; crowded Chrome store) | We are not building that. Keep the pitch on redact-then-reason + consent. |
| Secrets in the repo or testing instructions | No production keys, no real PII, no debug tokens in the form. |
| Video private, or still processing at deadline | Upload Nov 25; never use YouTube Private (judges cannot play it). |
| Commits after Nov 30 2:00 PM PT | Tag `v1.0.0-hackathon` on Nov 28; leave the judged repo alone. |
| `gemini-2.5-*` model names | Use `gemini-3.5-flash-lite`. |
| Starting Contract Gotcha so early that entry #1 is mid-quality | Gate the stretch on the Nov 26 checkpoint. |

### Out of scope (do not spend time here)

- iOS / Android / native Windows companion (Windows is not an eligible target).
- Image generation, TTS, Live API (billing, unsupported on-device, or both).
- Quota form (due Nov 25) — only if we suddenly need billing-required models. We do not.
- Chrome Web Store publication. Sideload + hosted demo is enough. Store review will not come back before Nov 30.
- Multi-turn on-device chat (`startChat`) — unsupported; don't fight it.

---

## 7. Definition of done (entry #1)

The project is done when all of the following are true:

1. A stranger can follow the README, sideload the extension on Chrome 139+ with the two flags, load a sample doc, see on-device explain with a 🔒 badge, and (on the hosted demo) complete a consented cloud call with a ☁️ badge and a redacted payload preview.
2. `rg "getGenerativeModel|generateContent" packages/core` shows real call sites.
3. `git ls-files` contains `LICENSE` and does not contain `.env`, debug tokens, or service accounts.
4. Devpost is **submitted** (not draft) with repo, video, description, and Web/Chrome platform, on or before Sunday, November 29.
5. The video is ≤ 3:00, playable incognito, and shows both inference paths.

Until item 4 is true, the hackathon entry is not finished.
