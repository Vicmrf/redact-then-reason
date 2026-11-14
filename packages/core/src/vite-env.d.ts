/// <reference types="vite/client" />

// Env keys read by @rtr/core. Values come from ONE gitignored `.env.local` at the
// repo root (every Vite config sets envDir to the repo root). See .env.example.
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_USE_APPCHECK_DEBUG?: string;
  readonly VITE_APPCHECK_DEBUG_TOKEN?: string;
  readonly VITE_RECAPTCHA_ENTERPRISE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
