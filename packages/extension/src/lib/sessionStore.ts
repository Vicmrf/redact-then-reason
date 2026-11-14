// Placeholder-map store (ARCHITECTURE 3.7). chrome.storage.session ONLY: cleared when the
// browser closes. Never chrome.storage.local or chrome.storage.sync. Never log map contents.
//
// Each document is stored as { map, entityPass }: the on-device entity-pass status travels with
// the map so a record without a "complete" status can never enable a cloud send. Records written
// before the status existed (a bare PlaceholderMap) read back as not complete.
import { toEntityPassStatus, type EntityPassStatus, type PlaceholderMap } from "@rtr/core";

const KEY_PREFIX = "rtr:map:";

export interface StoredDoc {
  map: PlaceholderMap;
  entityPass: EntityPassStatus;
}

function keyFor(docId: string): string {
  return KEY_PREFIX + docId;
}

function isMap(value: unknown): value is PlaceholderMap {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PlaceholderMap).docId === "string" &&
    Array.isArray((value as PlaceholderMap).entries)
  );
}

/** Pure. Reads a stored value; a missing / unknown entityPass is treated as not complete. */
export function parseStoredDoc(value: unknown): StoredDoc | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { map?: unknown; entityPass?: unknown };
  if (isMap(rec.map)) return { map: rec.map, entityPass: toEntityPassStatus(rec.entityPass) };
  if (isMap(value)) return { map: value, entityPass: "pending" }; // legacy record: no status
  return null;
}

export async function saveMap(map: PlaceholderMap, entityPass: EntityPassStatus): Promise<void> {
  const record: StoredDoc = { map, entityPass };
  await chrome.storage.session.set({ [keyFor(map.docId)]: record });
}

export async function loadDoc(docId: string): Promise<StoredDoc | null> {
  const key = keyFor(docId);
  const got = await chrome.storage.session.get(key);
  return parseStoredDoc(got[key]);
}

export async function loadMap(docId: string): Promise<PlaceholderMap | null> {
  return (await loadDoc(docId))?.map ?? null;
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
