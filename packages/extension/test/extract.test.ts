// Content-side extraction (ARCHITECTURE 3.1) in a DOM environment. All data is synthetic.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { extractPageText, MAX_CAPTURE_CHARS } from "../src/content/extract";

// node:path, not `new URL` (happy-dom replaces the global URL).
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../testdata/pages/medical-email.html");

function setBody(html: string, title = "Synthetic page"): void {
  document.title = title;
  document.body.innerHTML = html; // test setup only; the extractor itself never writes HTML
  window.getSelection()?.removeAllRanges();
}

const TAG_RE = /<\/?[a-z][a-z0-9-]*[\s>/]/i;

beforeEach(() => setBody(""));

describe("extractPageText: selection mode", () => {
  it("returns only the selected text", () => {
    setBody("<p id='a'>Not selected.</p><p id='b'>Selected Jane Q. Example text.</p>");
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("b")!);
    window.getSelection()!.addRange(range);
    const out = extractPageText("selection", MAX_CAPTURE_CHARS);
    expect(out).toMatchObject({ type: "PAGE_TEXT", mode: "selection", truncated: false });
    expect(out.text).toBe("Selected Jane Q. Example text.");
    expect(out.text).not.toContain("Not selected");
    expect(out.title).toBe("Synthetic page");
    expect(out.url).toBe("https://mail.example.com/inbox");
  });

  it("returns empty text when nothing is selected", () => {
    setBody("<p>Body text</p>");
    expect(extractPageText("selection", MAX_CAPTURE_CHARS).text).toBe("");
  });
});

describe("extractPageText: page mode", () => {
  it("drops nav/footer/aside/header/script/style/hidden and keeps the content", () => {
    setBody(`
      <header>Site header</header>
      <nav>Inbox Starred Sent</nav>
      <div><p>First paragraph.</p><p>Second   paragraph.</p></div>
      <aside>Sponsored ad</aside>
      <script>var secret = "<b>script</b>";</script>
      <style>.x { color: red }</style>
      <noscript>Enable JS</noscript>
      <template><p>template text</p></template>
      <div hidden>Hidden text</div>
      <div aria-hidden="true">Aria hidden</div>
      <footer>Footer links</footer>`);
    const out = extractPageText("page", MAX_CAPTURE_CHARS);
    expect(out.mode).toBe("page");
    expect(out.text).toContain("First paragraph.");
    expect(out.text).toContain("Second paragraph.");
    for (const gone of ["Site header", "Inbox Starred", "Sponsored", "secret", "color: red", "Enable JS", "template text", "Hidden text", "Aria hidden", "Footer links"]) {
      expect(out.text).not.toContain(gone);
    }
    expect(out.text).toMatch(/First paragraph\.\n+Second paragraph\./);
  });

  it("prefers <main>, then <article>, over the whole body", () => {
    setBody("<div>Outside chrome</div><main><p>Main content</p></main>");
    expect(extractPageText("page", MAX_CAPTURE_CHARS).text).toBe("Main content");
    setBody("<div>Outside chrome</div><article><p>Article content</p></article>");
    expect(extractPageText("page", MAX_CAPTURE_CHARS).text).toBe("Article content");
    setBody("<main>   </main><p>Body fallback</p>");
    expect(extractPageText("page", MAX_CAPTURE_CHARS).text).toBe("Body fallback");
  });

  it("does not mutate the live page", () => {
    setBody("<nav>Menu</nav><p>Text</p><script>1</script>");
    const before = document.body.innerHTML;
    extractPageText("page", MAX_CAPTURE_CHARS);
    expect(document.body.innerHTML).toBe(before);
  });

  it("collapses 3+ newlines and never returns HTML tags", () => {
    setBody("<p>A</p><div></div><div></div><div></div><p>B &lt;b&gt;not a tag in source&lt;/b&gt;</p><p><b>bold</b> <i>it</i></p>");
    const out = extractPageText("page", MAX_CAPTURE_CHARS);
    expect(out.text).not.toMatch(/\n{3,}/);
    expect(out.text).toContain("bold it");
    expect(out.text).not.toMatch(/<\/?(p|div|i)[\s>/]/i);
    expect(out.text).not.toContain("<i>");
  });

  it("caps text and sets the truncated flag", () => {
    setBody(`<p>${"x".repeat(500)}</p>`);
    const out = extractPageText("page", 100);
    expect(out.text.length).toBe(100);
    expect(out.truncated).toBe(true);
    expect(extractPageText("page", 1000).truncated).toBe(false);
  });

  it("is self-contained (runs after toString() like chrome.scripting does)", () => {
    setBody("<main><p>Self contained</p></main>");
    const rebuilt = new Function(`return (${extractPageText.toString()})`)() as typeof extractPageText;
    expect(rebuilt("page", MAX_CAPTURE_CHARS).text).toBe("Self contained");
  });

  it("extracts the synthetic Gmail-like fixture without nav/aside chrome", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    const out = extractPageText("page", MAX_CAPTURE_CHARS);
    expect(out.title).toContain("Balance due");
    expect(out.text).toContain("outstanding balance of $245.80");
    expect(out.text).toContain("billing@example.org");
    expect(out.text).not.toContain("Starred");
    expect(out.text).not.toContain("Snoozed");
    expect(out.text).not.toContain("Sponsored");
    expect(TAG_RE.test(out.text)).toBe(false);
  });
});
