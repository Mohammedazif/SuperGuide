import { h, render } from "preact";
import type { SuperGuideClient } from "@superguide/client-core";
import { Widget } from "./app.js";
import { WIDGET_STYLES } from "./styles.js";

export const SHADOW_HOST_ID = "superguide-root";

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

// Closed shadow root + constructed stylesheet: host CSP stays untouched.
export function mountWidget(options: MountOptions): MountedWidget {
  const target = options.document ?? document;
  const existing = target.getElementById(SHADOW_HOST_ID);
  existing?.remove();

  const host = target.createElement("div");
  host.id = SHADOW_HOST_ID;
  host.setAttribute("data-superguide", "root");
  target.body.append(host);

  const shadow = host.attachShadow({ mode: "closed" });

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
  shadow.append(container);

  let currentlyOpen = options.initiallyOpen ?? false;

  const draw = (open: boolean): void => {
    currentlyOpen = open;
    render(
      h(Widget, {
        client: options.client,
        title: options.title ?? "Get this done",
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
      render(null, container);
      host.remove();
    },
  };
}
