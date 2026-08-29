import type { ColorScheme } from "./theme.js";

const MOVE_MS = 450;
const RING_MS = 220;
const RING_PAD = 2;
const KEY_EVENTS = ["keydown", "keypress", "keyup", "paste"] as const;

export interface ActLayer {
  setLocked(locked: boolean): void;
  paint(scheme: ColorScheme): void;
  highlight(element: Element): Promise<void>;
  remove(): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function fromHost(event: Event, host: HTMLElement): boolean {
  if (typeof event.composedPath === "function") {
    return event.composedPath().includes(host);
  }
  return event.target instanceof Node && host.contains(event.target);
}

function pointerGlyph(doc: Document, fill: string): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "24");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 2 L4 18 L8.8 14.6 L12.2 22.2 L15.2 20.8 L11.5 13.4 L17.5 13.2 Z");
  path.setAttribute("fill", fill);
  path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export function createActLayer(
  doc: Document,
  shadow: ShadowRoot,
  host: HTMLElement,
  onStop: () => void,
): ActLayer {
  const trap = doc.createElement("div");
  trap.style.cssText =
    "position:fixed;inset:0;pointer-events:none;background:transparent;display:none;z-index:0";

  const pill = doc.createElement("div");
  pill.setAttribute("role", "status");
  pill.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:none;" +
    "align-items:center;gap:10px;padding:8px 12px;border-radius:999px;" +
    "font:12px/1.3 system-ui,sans-serif;pointer-events:auto;z-index:4;" +
    "box-shadow:0 4px 16px rgba(0,0,0,0.18)";

  const label = doc.createElement("span");
  label.textContent = "SuperGuide is running";

  const stop = doc.createElement("button");
  stop.textContent = "Stop";
  stop.style.cssText =
    "border-radius:999px;border:1px solid;padding:3px 10px;cursor:pointer;" +
    "font:600 11px/1.2 system-ui,sans-serif;background:transparent";

  const cursor = doc.createElement("div");
  cursor.style.cssText =
    "position:fixed;left:0;top:0;width:18px;height:24px;pointer-events:none;z-index:3;display:none;" +
    `transition:left ${String(MOVE_MS)}ms cubic-bezier(.22,.7,0,1),top ${String(MOVE_MS)}ms cubic-bezier(.22,.7,0,1)`;
  cursor.append(pointerGlyph(doc, "#1a1a2e"));

  pill.append(label, stop);
  shadow.append(trap, pill, cursor);

  let locked = false;
  let scheme: ColorScheme = "light";
  let highlightGen = 0;
  let ring: HTMLDivElement | null = null;
  let placed = false;

  const view = (): { w: number; h: number } => {
    const win = doc.defaultView;
    return { w: win?.innerWidth ?? 1280, h: win?.innerHeight ?? 720 };
  };

  const blockPage = (event: Event): void => {
    if (!locked || fromHost(event, host)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const attachKeys = (): void => {
    for (const name of KEY_EVENTS) {
      doc.addEventListener(name, blockPage, true);
    }
  };

  const detachKeys = (): void => {
    for (const name of KEY_EVENTS) {
      doc.removeEventListener(name, blockPage, true);
    }
  };

  const dropRing = (): void => {
    highlightGen += 1;
    ring?.remove();
    ring = null;
  };

  const paint = (next: ColorScheme): void => {
    scheme = next;
    const dark = next === "dark";
    pill.style.background = dark ? "#1c1c22" : "#fff";
    pill.style.color = dark ? "#ececf1" : "#1a1a2e";
    pill.style.border = dark ? "1px solid #3f3f4a" : "1px solid #d8dbe3";
    stop.style.borderColor = dark ? "#3f3f4a" : "#d8dbe3";
    stop.style.color = dark ? "#ececf1" : "#1a1a2e";
    const fill = dark ? "#ececf1" : "#1a1a2e";
    const path = cursor.querySelector("path");
    if (path !== null) path.setAttribute("fill", fill);
    if (ring !== null) ring.style.borderColor = dark ? "#8aa4e8" : "#2b3a67";
  };

  const placeCursor = (x: number, y: number, animate: boolean): void => {
    if (!animate) cursor.style.transition = "none";
    cursor.style.left = `${String(x)}px`;
    cursor.style.top = `${String(y)}px`;
    if (!animate) {
      void cursor.offsetWidth;
      cursor.style.transition =
        `left ${String(MOVE_MS)}ms cubic-bezier(.22,.7,0,1),` +
        `top ${String(MOVE_MS)}ms cubic-bezier(.22,.7,0,1)`;
    }
    placed = true;
  };

  const setLocked = (next: boolean): void => {
    if (next === locked) {
      host.dataset.sgLocked = next ? "true" : "false";
      return;
    }
    locked = next;
    host.dataset.sgLocked = next ? "true" : "false";
    trap.style.display = next ? "block" : "none";
    trap.style.pointerEvents = next ? "auto" : "none";
    pill.style.display = next ? "flex" : "none";
    cursor.style.display = next ? "block" : "none";
    if (next) {
      attachKeys();
      if (!placed) {
        const size = view();
        placeCursor(size.w * 0.5 - 8, size.h * 0.72, false);
      }
    } else {
      detachKeys();
      dropRing();
    }
  };

  stop.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onStop();
  });

  paint("light");
  setLocked(false);

  return {
    setLocked,
    paint,
    highlight: async (element) => {
      if (!(element instanceof Element)) return;
      if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      dropRing();
      const gen = highlightGen;
      const destX = rect.left + rect.width * 0.35;
      const destY = rect.top + rect.height * 0.35;
      cursor.style.display = "block";
      if (!placed) {
        const size = view();
        placeCursor(size.w * 0.5 - 8, size.h * 0.72, false);
      }
      placeCursor(destX, destY, true);
      await wait(MOVE_MS);
      if (gen !== highlightGen) return;
      const next = doc.createElement("div");
      next.style.cssText =
        "position:fixed;pointer-events:none;border:2px solid;border-radius:8px;box-sizing:border-box;z-index:2";
      next.style.top = `${String(rect.top - RING_PAD)}px`;
      next.style.left = `${String(rect.left - RING_PAD)}px`;
      next.style.width = `${String(rect.width + RING_PAD * 2)}px`;
      next.style.height = `${String(rect.height + RING_PAD * 2)}px`;
      next.style.borderColor = scheme === "dark" ? "#8aa4e8" : "#2b3a67";
      shadow.append(next);
      ring = next;
      await wait(RING_MS);
      if (gen !== highlightGen) return;
      next.remove();
      if (ring === next) ring = null;
    },
    remove: () => {
      setLocked(false);
      dropRing();
      trap.remove();
      pill.remove();
      cursor.remove();
    },
  };
}
