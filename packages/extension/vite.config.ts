import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  // ONE shared, gitignored .env.local lives at the repo root.
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  build: { sourcemap: true },
});
