// Side panel entry. Status + Day-1 stack check (Firebase + App Check -> getAI ->
// initializeDeviceModel -> ONLY_ON_DEVICE generateContent) and the Day-3 redact/explain flow
// (redactPanel.ts). Every model call in this panel is ONLY_ON_DEVICE.
// All text is rendered with textContent. Never innerHTML.
import { getDebugToken } from "./debugToken";
import {
  initFirebase,
  probeNano,
  startDeviceModel,
  generateOnDevice,
  InferenceSource,
  FirebaseNotConfiguredError,
} from "@rtr/core";
import { initRedactPanel } from "./redactPanel";

const HELLO_PROMPT = "Say hello in five words";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in side panel markup`);
  return node as T;
}

const ui = {
  badge: el("badge"),
  firebaseStatus: el("firebase-status"),
  nanoStatus: el("nano-status"),
  helloBtn: el<HTMLButtonElement>("hello-btn"),
  progressWrap: el("progress-wrap"),
  progress: el<HTMLProgressElement>("progress"),
  progressLabel: el("progress-label"),
  step: el("step"),
  result: el("result"),
  resultText: el("result-text"),
  resultSource: el("result-source"),
  error: el("error"),
  privacy: el("privacy"),
  debugToken: el("debug-token"),
  debugTokenCopy: el<HTMLButtonElement>("debug-token-copy"),
  debugTokenHint: el("debug-token-hint"),
};

function describeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/app.?check|403|permission_denied/i.test(msg)) {
    return `${msg}\n\nHint: App Check rejected the request. Register the debug token shown in this panel (Firebase console > App Check > Apps > your web app > Manage debug tokens), put it in the root .env.local as VITE_APPCHECK_DEBUG_TOKEN, and rebuild.`;
  }
  if (/unavailable|not available|on-device model/i.test(msg)) {
    return `${msg}\n\nHint: Gemini Nano is not usable here. Check Chrome 139+, the two chrome://flags entries in the README, free disk space and hardware.`;
  }
  return msg;
}

function showError(err: unknown): void {
  ui.error.textContent = describeError(err);
  ui.error.hidden = false;
}

function clearError(): void {
  ui.error.textContent = "";
  ui.error.hidden = true;
}

function setBadge(source: string): void {
  ui.badge.classList.remove("badge--idle", "badge--device", "badge--cloud", "badge--unknown");
  if (source === InferenceSource.ON_DEVICE) {
    ui.badge.textContent = "🔒 On-device";
    ui.badge.classList.add("badge--device");
  } else if (source === InferenceSource.IN_CLOUD) {
    ui.badge.textContent = "☁️ Cloud";
    ui.badge.classList.add("badge--cloud");
  } else {
    ui.badge.textContent = `Unknown source: ${source}`;
    ui.badge.classList.add("badge--unknown");
  }
}

function setProgress(pct: number): void {
  ui.progressWrap.hidden = false;
  ui.progress.value = pct;
  ui.progressLabel.textContent = `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%`;
}

async function refreshNano(): Promise<void> {
  try {
    ui.nanoStatus.textContent = await probeNano();
  } catch (err) {
    ui.nanoStatus.textContent = `probe failed (${err instanceof Error ? err.message : String(err)})`;
  }
}

function renderDebugToken(): void {
  const token = getDebugToken();
  if (!token) {
    ui.debugToken.textContent = "Not in debug mode";
    ui.debugTokenCopy.hidden = true;
    ui.debugTokenHint.hidden = true;
    return;
  }
  ui.debugToken.textContent = token;
  ui.debugTokenCopy.addEventListener("click", () => {
    void navigator.clipboard.writeText(token).then(
      () => {
        ui.debugTokenCopy.textContent = "Copied";
      },
      () => {
        ui.debugTokenCopy.textContent = "Copy failed";
      },
    );
  });
}

function boot(): void {
  renderDebugToken();
  try {
    // The MV3 extension can only use the App Check debug provider: reCAPTCHA Enterprise
    // cannot load under the extension CSP. initFirebase throws if debug mode is off.
    const { appCheckMode } = initFirebase({ appCheck: "debug-only" });
    ui.firebaseStatus.textContent = `Initialized (App Check: ${appCheckMode} provider, then getAI with GoogleAIBackend)`;
    ui.helloBtn.disabled = false;
  } catch (err) {
    ui.firebaseStatus.textContent =
      err instanceof FirebaseNotConfiguredError ? err.message : "Initialization failed";
    if (!(err instanceof FirebaseNotConfiguredError)) showError(err);
    ui.helloBtn.disabled = true;
  }
  void refreshNano();
}

async function onHelloClick(): Promise<void> {
  clearError();
  ui.helloBtn.disabled = true;
  ui.result.hidden = true;
  try {
    // Must run on a user gesture, before the first generateContent().
    ui.step.textContent = "Preparing Gemini Nano (first run downloads the model, this can take minutes)...";
    await startDeviceModel(setProgress);
    setProgress(100);
    void refreshNano();

    ui.step.textContent = `Running ONLY_ON_DEVICE generateContent("${HELLO_PROMPT}")...`;
    const { text, inferenceSource } = await generateOnDevice(HELLO_PROMPT);

    ui.resultText.textContent = text;
    ui.resultSource.textContent = inferenceSource;
    ui.result.hidden = false;
    setBadge(inferenceSource);
    ui.step.textContent = "Done.";
    if (inferenceSource === InferenceSource.ON_DEVICE) {
      ui.privacy.textContent = "Nothing has left this device.";
    }
  } catch (err) {
    ui.step.textContent = "Failed.";
    showError(err);
  } finally {
    ui.helloBtn.disabled = false;
  }
}

ui.helloBtn.addEventListener("click", () => {
  void onHelloClick();
});

boot();
initRedactPanel({
  setBadge,
  setProgress,
  refreshNano: () => {
    void refreshNano();
  },
  setPrivacy: (line) => {
    ui.privacy.textContent = line;
  },
});
