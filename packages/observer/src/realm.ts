type ElementConstructorName =
  | "HTMLInputElement"
  | "HTMLTextAreaElement"
  | "HTMLSelectElement"
  | "HTMLIFrameElement"
  | "HTMLElement";

// A same-origin iframe is a different realm, so its elements are not instances of the top
// window's constructors. Resolving the constructor from the element's own view is what makes
// traversal into a frame work at all, and it is also what lets this run outside a browser.
export function isElementOfType(value: unknown, name: ElementConstructorName): boolean {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as { ownerDocument?: { defaultView?: unknown } };
  const view = candidate.ownerDocument?.defaultView;
  if (typeof view !== "object" || view === null) return false;

  const constructor = (view as Record<string, unknown>)[name];
  if (typeof constructor !== "function") return false;
  return value instanceof (constructor as new () => unknown);
}

export function asInput(value: unknown): HTMLInputElement | null {
  return isElementOfType(value, "HTMLInputElement") ? (value as HTMLInputElement) : null;
}

export function asTextArea(value: unknown): HTMLTextAreaElement | null {
  return isElementOfType(value, "HTMLTextAreaElement") ? (value as HTMLTextAreaElement) : null;
}

export function asSelect(value: unknown): HTMLSelectElement | null {
  return isElementOfType(value, "HTMLSelectElement") ? (value as HTMLSelectElement) : null;
}

export function asFrame(value: unknown): HTMLIFrameElement | null {
  return isElementOfType(value, "HTMLIFrameElement") ? (value as HTMLIFrameElement) : null;
}
