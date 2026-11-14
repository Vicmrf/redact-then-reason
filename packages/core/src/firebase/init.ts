// Firebase AI Logic initialization (TECH-SPEC 3.2).
// Order is mandatory: App Check debug token -> initializeApp -> initializeAppCheck -> getAI.
// Call from the side panel (or web demo page) only, never from the service worker.
import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  CustomProvider,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
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
let debugOnlyRequested = false;

/** Returns true once initFirebase() has succeeded. */
export function isFirebaseInitialized(): boolean {
  return handles !== null;
}

export interface InitFirebaseOptions {
  /**
   * "debug-only": the caller (the MV3 extension) can only use the App Check debug
   * provider. If debug mode is not enabled, initFirebase throws instead of ever
   * constructing ReCaptchaEnterpriseProvider. "auto" (default): debug provider when
   * debug mode is on, reCAPTCHA Enterprise otherwise (hosted web demo).
   */
  appCheck?: "auto" | "debug-only";
}

/**
 * Idempotent. Throws FirebaseNotConfiguredError when apiKey / projectId / appId
 * (or, outside debug mode, the reCAPTCHA Enterprise site key) are missing,
 * without touching any Firebase API.
 */
export function initFirebase(opts: InitFirebaseOptions = {}): FirebaseHandles {
  // Sticky: once a caller declares "debug-only", later option-less calls (e.g. the
  // lazy model getters) cannot fall through to the Enterprise provider either.
  if (opts.appCheck === "debug-only") debugOnlyRequested = true;
  if (handles) return handles;

  const firebaseConfig = readFirebaseConfig();
  const missing: string[] = [];
  if (!firebaseConfig.apiKey) missing.push("VITE_FIREBASE_API_KEY");
  if (!firebaseConfig.projectId) missing.push("VITE_FIREBASE_PROJECT_ID");
  if (!firebaseConfig.appId) missing.push("VITE_FIREBASE_APP_ID");
  if (missing.length > 0) throw new FirebaseNotConfiguredError(missing);

  // --- App Check: this MUST run before getAI(). ---
  // Read the statically-replaced env values inline so Vite can fold this to a
  // constant and drop the Enterprise branch from the debug extension bundle.
  // Correctness does NOT depend on that: the branches below are explicit.
  const useDebug =
    import.meta.env.DEV || import.meta.env.VITE_USE_APPCHECK_DEBUG === "true";

  if (!useDebug && debugOnlyRequested) {
    // The MV3 extension must never construct ReCaptchaEnterpriseProvider: its
    // initialize() injects https://www.google.com/recaptcha/enterprise.js, which
    // the extension CSP (script-src 'self') blocks.
    throw new Error(
      "Extension build requires VITE_USE_APPCHECK_DEBUG=true; reCAPTCHA Enterprise cannot load under MV3 CSP.",
    );
  }

  let siteKey: string | undefined;
  if (!useDebug) {
    siteKey = nonEmpty(import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY);
    if (!siteKey) throw new FirebaseNotConfiguredError(["VITE_RECAPTCHA_ENTERPRISE_KEY"]);
  }

  // Do not overwrite a string (or any value) already set on the global, e.g. by
  // the side-panel debugToken module which runs before this package is imported.
  if (useDebug && self.FIREBASE_APPCHECK_DEBUG_TOKEN === undefined) {
    // Token comes from the gitignored root .env.local. Never hardcode it.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN =
      nonEmpty(import.meta.env.VITE_APPCHECK_DEBUG_TOKEN) || true;
  }

  const app = initializeApp(firebaseConfig);

  // initializeAppCheck still requires a provider object.
  //
  // Debug mode (extension, localhost): deliberate deviation from TECH-SPEC 3.2,
  // which passes a placeholder-key ReCaptchaEnterpriseProvider. That provider's
  // initialize() injects the reCAPTCHA Enterprise script even when a debug token
  // is set, producing a CSP violation in the MV3 side panel. We pass a
  // CustomProvider instead: its initialize() injects nothing, and in debug mode
  // the SDK exchanges FIREBASE_APPCHECK_DEBUG_TOKEN and never calls the
  // provider's getToken (@firebase/app-check 0.13.x). If it ever were called, it
  // rejects loudly rather than silently attesting with something else.
  //
  // Hosted web demo (non-debug): reCAPTCHA Enterprise with the real site key (TECH-SPEC 4.3).
  const provider = useDebug
    ? new CustomProvider({
        getToken: () =>
          Promise.reject(
            new Error(
              "App Check debug mode: debug token should be used; custom provider must not be called",
            ),
          ),
      })
    : new ReCaptchaEnterpriseProvider(siteKey!);

  const appCheck = initializeAppCheck(app, {
    provider,
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
