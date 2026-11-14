// Separate from vite.config.ts so unit tests do not load the CRXJS plugin or the manifest build.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    environmentOptions: { happyDOM: { url: "https://mail.example.com/inbox" } },
    include: ["test/**/*.test.ts"],
  },
});
