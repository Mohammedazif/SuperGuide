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

// Form-like controls are kept even when they have no accessible name: hosts
// often leave comboboxes and text fields unlabeled. Decorative unnamed buttons
// stay out unless they sit in a modal.
const NAMELESS_KEEP_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "dialog",
  "alertdialog",
  "switch",
  "slider",
  "checkbox",
  "radio",
]);

// Select and menu content is often portaled to document.body, outside the dialog.
const PORTALED_POPUP_ROLES = new Set([
  "listbox",
  "menu",
  "tree",
  "grid",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
]);

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;

  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  return true;
}

function composedAncestors(element: Element): Element[] {
  const ancestors: Element[] = [];
  let current: Node = element;
  for (;;) {
    if (current.nodeType === 1) ancestors.push(current as Element);
    const parent = current.parentNode;
    if (parent !== null) {
      current = parent;
      continue;
    }
    const root = current.getRootNode();
    if (root !== current && "host" in root) {
      current = (root as ShadowRoot).host;
      continue;
    }
    break;
  }
  return ancestors;
}

function isInertOrAriaHidden(element: Element, overlayRoots: readonly Element[]): boolean {
  const overlays = new Set(overlayRoots);
  for (const ancestor of composedAncestors(element)) {
    // Modal contents stay operable even when the page root behind them is aria-hidden/inert.
    if (overlays.has(ancestor)) return false;
    if (ancestor.hasAttribute("inert")) return true;
    if (ancestor.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

function isNativeDialogOpen(element: Element): boolean {
  if (element.tagName !== "DIALOG") return false;
  return (element as HTMLDialogElement).open;
}

function isInsideClosedNativeDialog(element: Element): boolean {
  for (const ancestor of composedAncestors(element)) {
    if (ancestor.tagName === "DIALOG" && !isNativeDialogOpen(ancestor)) return true;
  }
  return false;
}

// Any host's modal: native <dialog open>, role=dialog|alertdialog, or aria-modal.
function isOpenModalRoot(element: Element): boolean {
  if (isInsideClosedNativeDialog(element)) return false;
  const role = roleOf(element);
  const dialogRole = role === "dialog" || role === "alertdialog";
  const ariaModal = element.getAttribute("aria-modal") === "true";
  const dataOpen = element.getAttribute("data-state") === "open";
  if (!isNativeDialogOpen(element) && !dialogRole && !ariaModal) return false;
  if (isVisible(element)) return true;
  // Opening animations sometimes hide the node for a frame; data-state=open still means it is the overlay.
  return dataOpen && (dialogRole || ariaModal);
}

function isInsideRoots(element: Element, roots: readonly Element[]): boolean {
  if (roots.length === 0) return false;
  const set = new Set(roots);
  for (const ancestor of composedAncestors(element)) {
    if (set.has(ancestor)) return true;
  }
  return false;
}

function inViewport(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;

  const rect = element.getBoundingClientRect();
  const height = view.innerHeight;
  const width = view.innerWidth;
  // Headless layout (0×0 at origin) counts as in-view so elements are not silently dropped.
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

// Password values never emit; other values only if the product allowlist names the field.
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
    const overlayRoots: Element[] = [];
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

        if (isOpenModalRoot(element) && !overlayRoots.includes(element)) {
          overlayRoots.push(element);
        }

        const role = roleOf(element);
        if (role === null) continue;
        if (
          !isVisible(element) ||
          isInertOrAriaHidden(element, overlayRoots) ||
          isInsideClosedNativeDialog(element)
        ) {
          continue;
        }

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

    const insideOverlay = (element: Element): boolean => isInsideRoots(element, overlayRoots);

    const useful = candidates.filter((candidate) => {
      if (candidate.name.length > 0) return true;
      if (NAMELESS_KEEP_ROLES.has(candidate.role)) return true;
      return insideOverlay(candidate.element);
    });

    // Prefer the open modal on any host. Keep portaled pickers that render
    // outside it; many component libraries attach menus to document.body.
    const scoped =
      overlayRoots.length === 0
        ? useful
        : useful.filter(
            (candidate) =>
              insideOverlay(candidate.element) || PORTALED_POPUP_ROLES.has(candidate.role),
          );

    scoped.sort((left, right) => {
      if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1;
      return left.order - right.order;
    });

    const kept = scoped.slice(0, maxElements);
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
      truncated: scoped.length > kept.length,
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
