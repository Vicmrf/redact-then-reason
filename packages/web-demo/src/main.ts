// Placeholder for the Day-6 hosted demo. Availability probe only; no model calls yet.
import { CORE_VERSION, probeNano } from "@rtr/core";

const versionEl = document.getElementById("version");
const nanoEl = document.getElementById("nano");

if (versionEl) versionEl.textContent = CORE_VERSION;

probeNano()
  .then((status) => {
    if (nanoEl) nanoEl.textContent = status;
  })
  .catch((err: unknown) => {
    if (nanoEl) nanoEl.textContent = `probe failed (${err instanceof Error ? err.message : String(err)})`;
  });
