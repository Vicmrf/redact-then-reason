// Placeholder-map store (ARCHITECTURE 3.7). chrome.storage.session ONLY: cleared when the
// browser closes. Never chrome.storage.local or chrome.storage.sync. Never log map contents.
import type { PlaceholderMap } from "@rtr/core";

const KEY_PREFIX = "rtr:map:";

function keyFor(docId: string): string {
  return KEY_PREFIX + docId;
}

export async function saveMap(map: PlaceholderMap): Promise<void> {
  await chrome.storage.session.set({ [keyFor(map.docId)]: map });
}

export async function loadMap(docId: string): Promise<PlaceholderMap | null> {
  const key = keyFor(docId);
  const got = await chrome.storage.session.get(key);
  const value = got[key] as PlaceholderMap | undefined;
  return value ?? null;
}

export async function clearMap(docId: string): Promise<void> {
  await chrome.storage.session.remove(keyFor(docId));
}

/** Removes every placeholder map this extension stored in session storage. */
export async function clearAll(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}
