import { h, render } from "preact";
import type { SuperGuideClient } from "@superguide/client-core";
import { Widget } from "./app.js";
import { WIDGET_STYLES } from "./styles.js";
import { watchScheme } from "./theme.js";

export const SHADOW_HOST_ID = "superguide-root";
const PAGE_EVENTS = [
  "keydown",
  "keypress",
  "keyup",
  "paste",
  "beforeinput",
  "compositionstart",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "touchstart",
  "touchend",
  "contextmenu",
  "focusin",
  "focusout",
] as const;

export interface MountOptions {
  client: SuperGuideClient;
  title?: string;
  initiallyOpen?: boolean;
  document?: Document;
}

export interface MountedWidget {
  open(): void;
  close(): void;
  unmount(): void;
}

function stopPagePropagation(event: Event): void {
  event.stopPropagation();
}

function isolateFromPage(node: EventTarget): void {
  for (const name of PAGE_EVENTS) {
    node.addEventListener(name, stopPagePropagation);
  }
}

// Closed shadow root + constructed stylesheet: host CSP stays untouched.
export function mountWidget(options: MountOptions): MountedWidget {
  const target = options.document ?? document;
  const existing = target.getElementById(SHADOW_HOST_ID);
  existing?.remove();

  const host = target.createElement("div");
  host.id = SHADOW_HOST_ID;
  host.setAttribute("data-superguide", "root");
  host.style.cssText =
    "position:fixed;inset:auto;right:0;bottom:0;width:0;height:0;margin:0;padding:0;" +
    "border:none;overflow:visible;background:transparent;pointer-events:none;z-index:2147483647;" +
    "outline:none;caret-color:transparent";
  host.setAttribute("contenteditable", "true");
  host.setAttribute("spellcheck", "false");
  host.tabIndex = -1;
  target.body.append(host);

  const shadow = host.attachShadow({ mode: "closed" });
  isolateFromPage(shadow);
  isolateFromPage(host);
  host.addEventListener("beforeinput", (event) => {
    const origin = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
    if (origin === host) event.preventDefault();
  });

  const view = target.defaultView;
  if (view !== null && "CSSStyleSheet" in view && "adoptedStyleSheets" in shadow) {
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(WIDGET_STYLES);
    shadow.adoptedStyleSheets = [sheet];
  } else {
    const style = target.createElement("style");
    style.textContent = WIDGET_STYLES;
    shadow.append(style);
  }

  const container = target.createElement("div");
  container.style.pointerEvents = "auto";
  isolateFromPage(container);
  shadow.append(container);

  const stopTheme = watchScheme(target, host);
  let currentlyOpen = options.initiallyOpen ?? false;

  const draw = (open: boolean): void => {
    currentlyOpen = open;
    render(
      h(Widget, {
        client: options.client,
        title: options.title ?? "SuperGuide",
        open,
        onOpenChange: (next: boolean) => {
          draw(next);
        },
      }),
      container,
    );
  };

  draw(currentlyOpen);

  return {
    open() {
      if (!currentlyOpen) draw(true);
    },
    close() {
      if (currentlyOpen) draw(false);
    },
    unmount() {
      stopTheme();
      render(null, container);
      host.remove();
    },
  };
}
