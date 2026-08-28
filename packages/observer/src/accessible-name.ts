function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFrom(element: Element | null): string {
  if (element === null) return "";
  return collapse(element.textContent);
}

function labelFor(element: Element): string {
  const ownerDocument = element.ownerDocument;
  const id = element.getAttribute("id");

  if (id !== null && id.length > 0) {
    const escaped = id.replace(/["\\]/g, "\\$&");
    const label = ownerDocument.querySelector(`label[for="${escaped}"]`);
    const named = textFrom(label);
    if (named.length > 0) return named;
  }

  let ancestor: Element | null = element.parentElement;
  while (ancestor !== null) {
    if (ancestor.tagName === "LABEL") {
      const clone = ancestor.cloneNode(true) as Element;
      for (const control of clone.querySelectorAll("input, select, textarea")) control.remove();
      const named = textFrom(clone);
      if (named.length > 0) return named;
    }
    ancestor = ancestor.parentElement;
  }
  return "";
}

export function accessibleName(element: Element): string {
  const associated = labelFor(element);
  if (associated.length > 0) return associated;

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel !== null && collapse(ariaLabel).length > 0) return collapse(ariaLabel);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      if (id.length === 0) continue;
      const referenced = element.ownerDocument.getElementById(id);
      const named = textFrom(referenced);
      if (named.length > 0) parts.push(named);
    }
    if (parts.length > 0) return collapse(parts.join(" "));
  }

  const title = element.getAttribute("title");
  if (title !== null && collapse(title).length > 0) return collapse(title);

  const placeholder = element.getAttribute("placeholder");
  if (placeholder !== null && collapse(placeholder).length > 0) return collapse(placeholder);

  const name = element.getAttribute("name");
  if (name !== null && collapse(name).length > 0) return collapse(name);

  const own = textFrom(element);
  return own.length > 120 ? "" : own;
}
