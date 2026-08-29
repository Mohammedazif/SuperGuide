export type ColorScheme = "light" | "dark";

function hasWord(value: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${word}(?:[^a-z0-9]|$)`, "i").test(value);
}

function explicitScheme(element: Element): ColorScheme | null {
  const tokens = ["class", "data-theme", "data-color-scheme", "data-mode", "theme"]
    .map((name) => element.getAttribute(name) ?? "")
    .join(" ");
  if (hasWord(tokens, "dark")) return "dark";
  if (hasWord(tokens, "light")) return "light";
  return null;
}

export function detectScheme(doc: Document): ColorScheme {
  const html = doc.documentElement;
  const fromHtml = explicitScheme(html);
  if (fromHtml !== null) return fromHtml;
  const body = doc.querySelector("body");
  if (body !== null) {
    const fromBody = explicitScheme(body);
    if (fromBody !== null) return fromBody;
  }
  const view = doc.defaultView;
  if (view !== null) {
    const scheme = view.getComputedStyle(html).colorScheme;
    if (hasWord(scheme, "dark") && !hasWord(scheme, "light")) return "dark";
    try {
      if (view.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch {
      return "light";
    }
  }
  return "light";
}

export function applyScheme(host: HTMLElement, scheme: ColorScheme): void {
  host.dataset.sgTheme = scheme;
  host.style.colorScheme = scheme;
}

export function watchScheme(doc: Document, host: HTMLElement): () => void {
  const paint = (): void => {
    applyScheme(host, detectScheme(doc));
  };
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  const body = doc.querySelector("body");
  if (body !== null) {
    observer.observe(body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  }
  return () => {
    observer.disconnect();
  };
}
