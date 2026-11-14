# testdata

All files here are **synthetic**. No real person's data.

- Names and addresses are obviously fictional (Jane Q. Example, Sam Placeholder, 123 Example Street, Springfield).
- Emails use only the reserved `example.com` / `example.org` / `example.net` domains.
- Phone numbers use only the fictional `555-01xx` range.
- Card numbers are standard public test numbers (4111 1111 1111 1111, 5555 5555 5555 4444, 3782 822463 10005, 4242 4242 4242 4242).
- SSNs are publicly voided specimen numbers (078-05-1120, 123-45-6789). Values such as `900-xx-xxxx` or `000-xx-xxxx` appear only as negative examples that must **not** be detected.

Used by `packages/core/test/fixtures.test.ts`: each file is redacted, the masked output must pass pre-flight, and unmasking must restore the original exactly.
