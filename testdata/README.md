# testdata

All files here are **synthetic**. No real person's data.

- Names and addresses are obviously fictional (Jane Q. Example, Sam Placeholder, 123 Example Street, Springfield).
- Emails use only the reserved `example.com` / `example.org` / `example.net` domains.
- Phone numbers use only the fictional `555-01xx` range.
- Card numbers are standard public test numbers (4111 1111 1111 1111, 5555 5555 5555 4444, 3782 822463 10005, 4242 4242 4242 4242).
- SSNs are publicly voided specimen numbers (078-05-1120, 123-45-6789). Values such as `900-xx-xxxx` or `000-xx-xxxx` appear only as negative examples that must **not** be detected.

Used by `packages/core/test/fixtures.test.ts`: each file is redacted, the masked output must pass pre-flight, and unmasking must restore the original exactly.

## pages/ (end-to-end capture fixtures)

- `pages/medical-email.html`: a static, script-free, Gmail-like page (header, folder `nav`, `aside` with "Sponsored"/contacts, `footer`) wrapping the same synthetic medical email. It exercises the "Capture page" readable-text trim (only the email in `<main>` should land in the panel) and "Capture selection". Also used by `packages/extension/test/extract.test.ts`.

How to open it in Chrome with the extension loaded:

- **Local static server (recommended):** from the repo root run any static server, e.g. `npx serve testdata/pages` or `python -m http.server 8080 -d testdata/pages`, then open `http://localhost:<port>/medical-email.html`.
- **file://:** open the file directly, but first enable **"Allow access to file URLs"** for Redact-then-Reason in `chrome://extensions` (Details). Without it, capture shows a clear "allow access to file URLs" message.

Then click the toolbar icon (this grants `activeTab` for that tab) and use **Capture page** / **Capture selection**, or right-click > **Analyze with Redact-then-Reason**. Capture never runs a model: click **Redact**, then **Explain on-device** or **Draft reply on-device**.
