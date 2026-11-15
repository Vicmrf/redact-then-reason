// Presentational chip rendering for the redaction preview. DOM nodes + textContent only (never
// innerHTML). The container's resulting textContent is exactly the input string. Mirrors the
// extension's sidepanel/chips.ts.
import type { TypeCount } from "@rtr/core";

type ChipFamily = "person" | "contact" | "id" | "org" | "date" | "other";

const PLACEHOLDER_RE = /\[([A-Z]+(?:_[A-Z]+)*)_(\d+)\]/g;

const CHIP_FAMILY_BY_TYPE: Record<string, ChipFamily> = {
  PERSON: "person",
  EMAIL: "contact",
  PHONE: "contact",
  ADDRESS: "contact",
  IP: "contact",
  SSN: "id",
  CREDIT_CARD: "id",
  ACCOUNT: "id",
  MRN: "id",
  ORG: "org",
  DOB: "date",
  DATE: "date",
  OTHER: "other",
};

function chipFamily(type: string): ChipFamily {
  return CHIP_FAMILY_BY_TYPE[type] ?? "other";
}

function chipClassName(type: string): string {
  const slug = /^[A-Z_]+$/.test(type) ? type.toLowerCase().replace(/_/g, "-") : "other";
  return `chip chip--${slug} chip-fam--${chipFamily(type)}`;
}

function chip(doc: Document, type: string, text: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = chipClassName(type);
  span.textContent = text;
  return span;
}

export function renderMaskedChips(container: HTMLElement, masked: string): void {
  const doc = container.ownerDocument;
  const nodes: Node[] = [];
  let last = 0;
  for (const m of masked.matchAll(PLACEHOLDER_RE)) {
    const start = m.index ?? 0;
    if (start > last) nodes.push(doc.createTextNode(masked.slice(last, start)));
    nodes.push(chip(doc, m[1] ?? "OTHER", m[0]));
    last = start + m[0].length;
  }
  if (last < masked.length) nodes.push(doc.createTextNode(masked.slice(last)));
  container.replaceChildren(...nodes);
}

export function renderCountChips(container: HTMLElement, counts: readonly TypeCount[], emptyText: string): void {
  const doc = container.ownerDocument;
  if (counts.length === 0) {
    container.replaceChildren(doc.createTextNode(emptyText));
    return;
  }
  const nodes: Node[] = [];
  counts.forEach((c, i) => {
    if (i > 0) nodes.push(doc.createTextNode(", "));
    const span = chip(doc, c.type, `${c.type}: ${c.count}`);
    span.classList.add("chip--count");
    nodes.push(span);
  });
  container.replaceChildren(...nodes);
}
