import type { DigestDiff, DigestElement, PageDigest } from "@superguide/contract/public";
import { accessibleName } from "./accessible-name.js";
import { isHeadingRole, isInteractiveRole, isLandmarkRole, isObservableRole, roleOf } from "./roles.js";
import { mintRef, stableIdentifier } from "./refs.js";
import { asInput, asSelect, asTextArea, asFrame } from "./realm.js";

export interface ObserveOptions {
  maxElements?: number;
  valueAllowlist?: readonly string[];
  maxDepth?: number;
}

interface Candidate {
  element: Element;
  role: string;
  name: string;
  signature: string;
  inViewport: boolean;
  order: number;
}

const DEFAULT_MAX_ELEMENTS = 120;

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;

  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  return true;
}

function inViewport(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;

  const rect = element.getBoundingClientRect();
  const height = view.innerHeight;
  const width = view.innerWidth;
  // A layout engine that reports nothing (a headless document) is treated as in view rather
  // than silently dropping every element from the digest.
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) return true;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

function stateOf(element: Element): DigestElement["state"] | undefined {
  const state: NonNullable<DigestElement["state"]> = {};

  const checked = element.getAttribute("aria-checked");
  if (checked === "true" || checked === "false") state.checked = checked === "true";
  else {
    const input = asInput(element);
    if (input !== null && (input.type === "checkbox" || input.type === "radio")) {
      state.checked = input.checked;
    }
  }

  const expanded = element.getAttribute("aria-expanded");
  if (expanded === "true" || expanded === "false") state.expanded = expanded === "true";

  const selected = element.getAttribute("aria-selected");
  if (selected === "true" || selected === "false") state.selected = selected === "true";

  const disabled =
    element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
  if (disabled) state.disabled = true;

  return Object.keys(state).length === 0 ? undefined : state;
}

function isPasswordField(element: Element): boolean {
  const input = asInput(element);
  return input !== null && input.type === "password";
}

// Values are omitted by default. A value appears only when the product's own allowlist names
// the field, and a password field never appears under any configuration.
function valueOf(element: Element, allowlist: ReadonlySet<string>): string | undefined {
  if (isPasswordField(element)) return undefined;
  const field = asInput(element) ?? asTextArea(element) ?? asSelect(element);
  if (field === null) return undefined;

  const identifiers = [
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("data-field"),
  ].filter((value): value is string => value !== null && value.length > 0);

  const permitted = identifiers.some((identifier) => allowlist.has(identifier.toLowerCase()));
  if (!permitted) return undefined;
  return field.value;
}

function pathSignature(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current !== null && depth < 6) {
    const identifier = stableIdentifier(current.getAttribute("id"));
    const role = roleOf(current);
    const marker =
      identifier.length > 0
        ? `#${identifier}`
        : role !== null
          ? `@${role}`
          : current.tagName.toLowerCase();

    const parent: Element | null = current.parentElement;
    const index =
      parent === null ? 0 : [...parent.children].filter((child) => child.tagName === current?.tagName).indexOf(current);
    parts.push(`${marker}[${String(index)}]`);

    current = parent;
    depth += 1;
  }

  return parts.reverse().join("/");
}

export class PageObserver {
  readonly #refs = new Map<string, WeakRef<Element>>();

  resolve(ref: string): Element | null {
    const held = this.#refs.get(ref);
    if (held === undefined) return null;
    const element = held.deref();
    if (element === undefined) {
      this.#refs.delete(ref);
      return null;
    }
    if (!element.isConnected) return null;
    return element;
  }

  observe(document: Document, options: ObserveOptions = {}): PageDigest {
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
    const allowlist = new Set((options.valueAllowlist ?? []).map((entry) => entry.toLowerCase()));

    const candidates: Candidate[] = [];
    const headings: string[] = [];
    const landmarks: string[] = [];
    let order = 0;

    const visit = (root: Document | ShadowRoot | Element, depth: number): void => {
      if (depth > (options.maxDepth ?? 12)) return;

      const elements = root.querySelectorAll("*");
      for (const element of elements) {
        if (element.shadowRoot !== null) visit(element.shadowRoot, depth + 1);

        const frame = asFrame(element);
        if (frame !== null) {
          try {
            const inner = frame.contentDocument;
            // A cross-origin frame throws or returns null here. Neither is an error.
            if (inner !== null) visit(inner, depth + 1);
          } catch {
            continue;
          }
        }

        const role = roleOf(element);
        if (role === null) continue;
        if (!isVisible(element)) continue;

        const name = accessibleName(element);

        if (isHeadingRole(role)) {
          if (name.length > 0 && headings.length < 24) headings.push(name);
          continue;
        }
        if (isLandmarkRole(role)) {
          const label = name.length > 0 ? `${role}: ${name}` : role;
          if (landmarks.length < 16 && !landmarks.includes(label)) landmarks.push(label);
          continue;
        }
        if (!isInteractiveRole(role) && !isObservableRole(role)) continue;
        if (name.length === 0 && role !== "textbox") continue;

        candidates.push({
          element,
          role,
          name,
          signature: `${role}|${name}|${pathSignature(element)}`,
          inViewport: inViewport(element),
          order,
        });
        order += 1;
      }
    };

    visit(document, 0);

    candidates.sort((left, right) => {
      if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1;
      return left.order - right.order;
    });

    const kept = candidates.slice(0, maxElements);
    const taken = new Set<string>();
    const elements: DigestElement[] = [];

    this.#refs.clear();

    for (const candidate of kept) {
      const ref = mintRef(candidate.signature, taken);
      taken.add(ref);
      this.#refs.set(ref, new WeakRef(candidate.element));

      const state = stateOf(candidate.element);
      const value = valueOf(candidate.element, allowlist);

      elements.push({
        ref,
        role: candidate.role,
        name: candidate.name,
        inViewport: candidate.inViewport,
        ...(state === undefined ? {} : { state }),
        ...(value === undefined ? {} : { value }),
      });
    }

    return {
      url: document.defaultView?.location.href ?? "",
      title: document.title,
      headings,
      landmarks,
      elements,
      truncated: candidates.length > kept.length,
    };
  }
}

function sameElement(left: DigestElement, right: DigestElement): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diff(previous: PageDigest | null, next: PageDigest): DigestDiff {
  if (previous === null) {
    return {
      url: next.url,
      title: next.title,
      added: next.elements,
      removed: [],
      changed: [],
      truncated: next.truncated,
    };
  }

  const before = new Map(previous.elements.map((element) => [element.ref, element]));
  const after = new Map(next.elements.map((element) => [element.ref, element]));

  const added: DigestElement[] = [];
  const changed: DigestElement[] = [];
  const removed: string[] = [];

  for (const [ref, element] of after) {
    const earlier = before.get(ref);
    if (earlier === undefined) added.push(element);
    else if (!sameElement(earlier, element)) changed.push(element);
  }
  for (const ref of before.keys()) {
    if (!after.has(ref)) removed.push(ref);
  }

  return {
    url: previous.url === next.url ? null : next.url,
    title: previous.title === next.title ? null : next.title,
    added,
    removed,
    changed,
    truncated: next.truncated,
  };
}
