// App Check provider selection (CSP fix). Firebase is fully mocked: no network, no SDK init.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ name: "app" })),
  initializeAppCheck: vi.fn(() => ({ appCheck: true })),
  getAI: vi.fn(() => ({ ai: true })),
  recaptchaCtor: vi.fn(),
  customCtor: vi.fn(),
}));

vi.mock("firebase/app", () => ({ initializeApp: mocks.initializeApp }));
vi.mock("firebase/app-check", () => {
  class ReCaptchaEnterpriseProvider {
    constructor(public key: string) {
      mocks.recaptchaCtor(key);
    }
  }
  class CustomProvider {
    constructor(public opts: { getToken: () => Promise<unknown> }) {
      mocks.customCtor(opts);
    }
  }
  return { initializeAppCheck: mocks.initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider };
});
vi.mock("firebase/ai", () => ({
  getAI: mocks.getAI,
  GoogleAIBackend: class GoogleAIBackend {},
}));

function stubConfig(): void {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app-id");
  vi.stubEnv("VITE_APPCHECK_DEBUG_TOKEN", "");
}

async function freshInit() {
  vi.resetModules();
  return import("../src/firebase/init");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("self", globalThis); // Node test env has no `self`.
  delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  stubConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
});

describe("initFirebase App Check provider", () => {
  it("debug mode: passes a CustomProvider and never constructs ReCaptchaEnterpriseProvider", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "true");
    vi.stubEnv("VITE_RECAPTCHA_ENTERPRISE_KEY", "test-site-key");
    const { initFirebase } = await freshInit();
    const appCheckMod = await import("firebase/app-check");

    const h = initFirebase({ appCheck: "debug-only" });

    expect(h.appCheckMode).toBe("debug");
    expect(mocks.recaptchaCtor).not.toHaveBeenCalled();
    expect(mocks.customCtor).toHaveBeenCalledTimes(1);
    const opts = mocks.initializeAppCheck.mock.calls[0]![1] as { provider: unknown };
    expect(opts.provider).toBeInstanceOf(appCheckMod.CustomProvider);
    // The custom provider must refuse to mint tokens: debug token is the only attestation.
    const custom = opts.provider as { opts: { getToken: () => Promise<unknown> } };
    await expect(custom.opts.getToken()).rejects.toThrow(/debug token should be used/);
    // Default debug token is `true` when nothing set it before.
    expect(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(true);
    // App Check before getAI.
    expect(mocks.initializeAppCheck.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.getAI.mock.invocationCallOrder[0]!,
    );
  });

  it("debug mode via DEV also uses CustomProvider (auto mode)", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "");
    const { initFirebase } = await freshInit();
    initFirebase();
    expect(mocks.recaptchaCtor).not.toHaveBeenCalled();
    expect(mocks.customCtor).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an already-set debug token and is idempotent", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "true");
    globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = "preset-test-token";
    const { initFirebase } = await freshInit();
    const a = initFirebase({ appCheck: "debug-only" });
    const b = initFirebase();
    expect(a).toBe(b);
    expect(mocks.initializeApp).toHaveBeenCalledTimes(1);
    expect(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe("preset-test-token");
  });

  it('"debug-only" + non-debug env: throws and never constructs ReCaptchaEnterpriseProvider', async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "false");
    vi.stubEnv("VITE_RECAPTCHA_ENTERPRISE_KEY", "test-site-key");
    const { initFirebase } = await freshInit();

    expect(() => initFirebase({ appCheck: "debug-only" })).toThrow(
      /requires VITE_USE_APPCHECK_DEBUG=true.*MV3 CSP/,
    );
    // A later option-less call (lazy model getters) must not fall through either.
    expect(() => initFirebase()).toThrow(/MV3 CSP/);
    expect(mocks.recaptchaCtor).not.toHaveBeenCalled();
    expect(mocks.initializeAppCheck).not.toHaveBeenCalled();
    expect(mocks.initializeApp).not.toHaveBeenCalled();
  });

  it("non-debug web path with a key: constructs ReCaptchaEnterpriseProvider with that key", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "");
    vi.stubEnv("VITE_RECAPTCHA_ENTERPRISE_KEY", "test-site-key");
    const { initFirebase } = await freshInit();

    const h = initFirebase();

    expect(h.appCheckMode).toBe("recaptcha-enterprise");
    expect(mocks.recaptchaCtor).toHaveBeenCalledTimes(1);
    expect(mocks.recaptchaCtor).toHaveBeenCalledWith("test-site-key");
    expect(mocks.customCtor).not.toHaveBeenCalled();
    expect(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
  });

  it("non-debug web path without a key: throws FirebaseNotConfiguredError", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_APPCHECK_DEBUG", "");
    vi.stubEnv("VITE_RECAPTCHA_ENTERPRISE_KEY", "");
    const { initFirebase, FirebaseNotConfiguredError } = await freshInit();
    expect(() => initFirebase()).toThrow(FirebaseNotConfiguredError);
    expect(() => initFirebase()).toThrow(/VITE_RECAPTCHA_ENTERPRISE_KEY/);
    expect(mocks.recaptchaCtor).not.toHaveBeenCalled();
  });
});
