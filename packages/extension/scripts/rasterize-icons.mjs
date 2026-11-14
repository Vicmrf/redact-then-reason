// Rasterizes the hand-built logo SVGs into the extension's PNG icons, locally (no network).
// 16/32 come from the simplified logo-16.svg; 48/128 from the full logo.svg.
// Run with `pnpm -C packages/extension icons`; not part of the build. Commit the PNGs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_DIR = join(ROOT, "src/assets/logo");
const OUT_DIR = join(ROOT, "public/icons");

const JOBS = [
  { size: 16, src: "logo-16.svg" },
  { size: 32, src: "logo-16.svg" },
  { size: 48, src: "logo.svg" },
  { size: 128, src: "logo.svg" },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { size, src } of JOBS) {
  const svg = readFileSync(join(LOGO_DIR, src), "utf8");
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  const out = join(OUT_DIR, `${size}.png`);
  writeFileSync(out, png);
  console.log(`${src} -> public/icons/${size}.png (${png.length} bytes)`);
}
