// Firebase AI Logic initialization (TECH-SPEC 3.2).
// Order is mandatory: App Check debug token -> initializeApp -> initializeAppCheck -> getAI.
// Call from the side panel (or web demo page) only, never from the service worker.
import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";

declare global {
  // Read by the Firebase App Check debug provider. `true` makes the SDK print a
  // fresh debug token to the console; a string uses that registered token.
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

export interface FirebaseHandles {
  app: FirebaseApp;
  appCheck: AppCheck;
  ai: AI;
  /** "debug" in the extension / localhost builds; "recaptcha-enterprise" on the hosted demo. */
  appCheckMode: "debug" | "recaptcha-enterprise";
}

export class FirebaseNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Firebase not configured: copy .env.example to .env.local (repo root) and fill in ${missing.join(", ")}.`,
    );
    this.name = "FirebaseNotConfiguredError";
  }
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v.trim() : undefined;
}

// firebaseConfig is a public client config (TECH-SPEC 3.1). It is env-driven
// for now because the Firebase project is not final yet.
function readFirebaseConfig(): FirebaseOptions {
  return {
    apiKey: nonEmpty(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: nonEmpty(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: nonEmpty(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    storageBucket: nonEmpty(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: nonEmpty(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
    appId: nonEmpty(import.meta.env.VITE_FIREBASE_APP_ID),
  };
}

let handles: FirebaseHandles | null = null;

/** Returns true once initFirebase() has succeeded. */
export function isFirebaseInitialized(): boolean {
  return handles !== null;
}

/**
 * Idempotent. Throws FirebaseNotConfiguredError when apiKey / projectId / appId
 * are missing, without touching any Firebase API.
 */
export function initFirebase(): FirebaseHandles {
  if (handles) return handles;

  const firebaseConfig = readFirebaseConfig();
  const missing: string[] = [];
  if (!firebaseConfig.apiKey) missing.push("VITE_FIREBASE_API_KEY");
  if (!firebaseConfig.projectId) missing.push("VITE_FIREBASE_PROJECT_ID");
  if (!firebaseConfig.appId) missing.push("VITE_FIREBASE_APP_ID");
  if (missing.length > 0) throw new FirebaseNotConfiguredError(missing);

  // --- App Check: this MUST run before getAI(). ---
  const useDebug =
    import.meta.env.DEV || import.meta.env.VITE_USE_APPCHECK_DEBUG === "true";
  if (useDebug) {
    // Token comes from the gitignored root .env.local. Never hardcode it.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN =
      nonEmpty(import.meta.env.VITE_APPCHECK_DEBUG_TOKEN) || true;
  }

  const app = initializeApp(firebaseConfig);

  // initializeAppCheck still requires a provider object. In debug builds the
  // FIREBASE_APPCHECK_DEBUG_TOKEN set above is what actually attests, even if
  // the reCAPTCHA script cannot load under the extension CSP. The placeholder
  // site key is acceptable ONLY because the debug token is set first. Do not
  // ship that placeholder build as a "production" extension.
  const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(
      nonEmpty(import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY) || "debug-build-no-recaptcha",
    ),
    isTokenAutoRefreshEnabled: true,
  });

  const ai = getAI(app, { backend: new GoogleAIBackend() });

  handles = {
    app,
    appCheck,
    ai,
    appCheckMode: useDebug ? "debug" : "recaptcha-enterprise",
  };
  return handles;
}
