# Demo video script + shot-list — Redact-then-Reason

**Target: ~2:45. Hard cap 3:00 — judges stop watching at 3:00.** First 30 seconds must say who it's for, the problem, and how Firebase AI Logic (hybrid) solves it.

**What to record:** the live hosted demo, https://redact-then-reason.web.app, in Chrome. Optional 10–15 s cut of the real extension side panel (beat 7).

> **YouTube upload: set visibility to PUBLIC or UNLISTED — never Private** (judges can't play private videos). Upload early; processing can take hours. Check it plays in an incognito window, then paste the link into `docs/DEVPOST-DRAFT.md` and the Devpost form.

## Before you hit record (prep checklist)

- [ ] Chrome 139+ with the two flags from the README enabled, and Gemini Nano **already downloaded** (run Explain once beforehand so no download bar appears mid-take). Nano also needs to be ready for the cloud send — the consent dialog blocks Send until the on-device name/address check has finished.
- [ ] Open https://redact-then-reason.web.app and hard-refresh (Ctrl+Shift+R). Open **Diagnostics** once: *Firebase + App Check* should be initialized and *Gemini Nano availability* should be available. Collapse it again.
- [ ] Do one full dry run of every beat (on-device explain, draft, cloud explain) so the model is warm, then click **New document** to reset.
- [ ] 1920×1080, browser zoom ~110–125% so text is readable; hide bookmarks bar, close other tabs, turn off notifications.
- [ ] Only synthetic samples on screen — no real personal data anywhere (tabs, history, autofill).
- [ ] Record voiceover separately or re-take per beat; trim pauses while the model streams (speed up waits, don't fake output).

## Beats

| # | Time | On screen | Click / action | Voiceover |
|---|------|-----------|----------------|-----------|
| 1 | 0:00–0:15 | Hosted demo open. **Load a sample → Medical billing email** already loaded in the text box (raw: names, phone, email, claim numbers visible). | Slow scroll over the raw text. | "This is a medical bill. I want help understanding it — but I don't want my name, my numbers and my diagnosis sitting on someone's server." |
| 2 | 0:15–0:30 | Header: logo, badge reading *No inference yet*, tagline. Footer: "Built with Firebase AI Logic." | Hover the tagline. | "Redact-then-Reason uses Firebase AI Logic's hybrid inference. Gemini Nano does the private work on my device. The cloud only sees a redacted copy — and only if I say so." |
| 3 | 0:30–0:55 | **Redaction preview**: masked text with `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]`…; *Detected* counts; pre-flight line "0 unmasked emails/SSNs/cards/phones…"; note "On-device entity pass added N verified span(s)". | Click **Redact**. Point the cursor at a couple of placeholders, then the counts. | "First, redaction — all local. Fast detectors catch emails, phones and card numbers; then Gemini Nano, on-device, finds the names, organizations and addresses. This masked version is the only thing the cloud could ever see." |
| 4 | 0:55–1:20 | **Explain** card streaming. Badge flips to **🔒 On-device**; raw `inferenceSource` under the answer; status line "Nothing has left this browser." | Click **Explain on-device**. When done, point at the badge, then the raw inferenceSource, then the status line. | "Now I ask for an explanation. This runs fully on-device with Gemini Nano. The lock badge isn't a guess — it's read from the SDK's inferenceSource on every response. Nothing has left this browser." |
| 5 | 1:20–1:40 | **Draft a reply** card streaming, real names filled back in; badge still 🔒. | Type in *Optional draft instruction*: `Ask for a payment plan, keep it friendly` → click **Draft reply on-device**. | "It can draft a reply too. Nano writes from the redacted copy, and my real details are filled back in right here, locally." |
| 6a | 1:40–1:55 | **Load a sample → Tax notice (longer)**; preview updates. | Pick the sample → click **Redact** → under *Use cloud for a deeper answer* click **Explain**. Badge shows **☁️ Pending consent**. | "Some documents are longer, or the question is harder. That's where the cloud helps — but it never happens automatically." |
| 6b | 1:55–2:15 | **Consent dialog**: "Send a redacted copy to the cloud?", *Why the cloud is offered*, **Exact text that will be sent (N characters)**, masked counts + pre-flight line, *Destination: Firebase AI Logic / Gemini Developer API. The placeholder map is not included.* | Slowly scroll the exact-text box; hover 2–3 placeholders; point at the pre-flight line and Destination. **Hold on this shot ~3 s.** | "Before anything leaves, I see the exact text that will be sent — placeholders, not my data. It re-checks the payload and blocks Send if anything slipped through. The map back to my real details stays here." |
| 6c | 2:15–2:30 | Answer streams in the **Explain** card; badge flips to **☁️ Cloud**; raw `inferenceSource` under the answer; status line "Sent N characters of redacted text to Firebase AI Logic (Gemini cloud). The placeholder map stayed in this browser." | Click **Send redacted text to cloud**. Point at badge → status line. | "I click Send. Firebase AI Logic answers in the cloud — the badge flips to cloud — and the placeholders are filled back in locally." |
| 7 *(optional)* | 2:30–2:40 | Real extension: Chrome toolbar icon → **side panel** open next to a synthetic sample page, redaction preview + 🔒 badge. | Click the toolbar icon; click analyze on the page. | "The same engine ships as a Chrome extension, working on whatever page you're reading." |
| 8 | 2:40–2:50 | End card: **redact-then-reason.web.app** and **github.com/Vicmrf/redact-then-reason**, "Built with Firebase AI Logic · Gemini Nano + Gemini cloud". | Static card (or the page footer). | "On-device first. Cloud only with consent, redacted only. Try it at redact-then-reason.web.app." |

If you skip beat 7, move beat 8 up to 2:30–2:40 and finish around 2:40.

## Must-haves (don't cut these)

- 🔒 **On-device** badge visible (beat 4) **and** ☁️ **Cloud** badge visible (beat 6c) — both inference paths on screen.
- The **consent dialog with the exact redacted payload** held on screen long enough to read (beat 6b).
- "Firebase AI Logic" said out loud in the first 30 seconds.
- English narration (or English subtitles).
- Final length ≤ 3:00 — check the exported file duration before uploading.

## Fallbacks during recording

- **Download bar appears:** stop, let Nano finish, re-take the beat.
- **Consent dialog says Send is blocked** (on-device check not finished): close it, click **Redact** again and wait for the entity-pass note, then re-open the cloud review.
- **Cloud request fails / App Check error:** open Diagnostics, confirm Firebase + App Check is initialized, hard-refresh, re-take beat 6.
