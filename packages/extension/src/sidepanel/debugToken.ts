// Side-effect module: must be imported first in main.ts, before @rtr/core.
// Sets self.FIREBASE_APPCHECK_DEBUG_TOKEN to a string before initializeAppCheck().
// A string token is what the Firebase App Check SDK expects once registered
// in the Firebase console. The SDK (@firebase/app-check 0.13.1) reads the
// global lazily inside initializeDebugMode(), which initializeAppCheck()
// calls — not at import time.

const STORAGE_KEY = "rtr-appcheck-debug-token";

declare global {
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

function nonEmpty(v: string | undefined | null): string | undefined {
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function isDebugMode(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_USE_APPCHECK_DEBUG === "true";
}

function resolveToken(): string {
  const fromEnv = nonEmpty(import.meta.env.VITE_APPCHECK_DEBUG_TOKEN);
  if (fromEnv) return fromEnv;

  try {
    const persisted = nonEmpty(localStorage.getItem(STORAGE_KEY));
    if (persisted) return persisted;
  } catch {
    // localStorage may throw in a restricted context; fall through and generate.
  }

  const generated = crypto.randomUUID();
  try {
    localStorage.setItem(STORAGE_KEY, generated);
  } catch {
    // Still use the in-memory token for this session.
  }
  return generated;
}

function logToken(token: string): void {
  console.log(
    "%c APP CHECK DEBUG TOKEN ",
    "background:#111;color:#fff;font-size:16px;font-weight:bold;padding:6px 10px;border-radius:4px;",
    token,
  );
  console.warn("Copy this App Check debug token and register it in the Firebase console:", token);
}

let cached: string | null = null;

export function getDebugToken(): string | null {
  return cached;
}

if (isDebugMode()) {
  cached = resolveToken();
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = cached;
  logToken(cached);
}
