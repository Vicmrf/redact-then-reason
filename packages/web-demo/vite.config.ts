import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// ONE shared, gitignored .env.local lives at the repo root (same file the extension uses).
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("../..", import.meta.url));
  const env = loadEnv(mode, envDir, "VITE_");
  const hasRecaptcha = Boolean(env.VITE_RECAPTCHA_ENTERPRISE_KEY && env.VITE_RECAPTCHA_ENTERPRISE_KEY.trim());

  const define: Record<string, string> = {};
  if (hasRecaptcha) {
    // Public hosted demo: once a reCAPTCHA Enterprise site key exists, use it for App Check so a
    // cold judge browser can run the consented cloud path. reCAPTCHA Enterprise cannot present an
    // App Check *debug* token, so the web-demo build turns debug mode off here. The extension
    // build (which requires debug mode) is a separate `vite build` and is unaffected. Until a key
    // is set, the shared VITE_USE_APPCHECK_DEBUG=true is kept so the on-device path still works
    // on the deployed demo.
    define["import.meta.env.VITE_USE_APPCHECK_DEBUG"] = JSON.stringify("false");
  }

  return {
    envDir,
    define,
    build: { sourcemap: true },
  };
});
