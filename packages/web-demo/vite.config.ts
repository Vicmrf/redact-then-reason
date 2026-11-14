import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // ONE shared, gitignored .env.local lives at the repo root.
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  build: { sourcemap: true },
});
