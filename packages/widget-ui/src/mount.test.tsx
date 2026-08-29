// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ClientState, SuperGuideClient } from "@superguide/client-core";
import { mountWidget, SHADOW_HOST_ID } from "./mount.js";

function stubClient(): SuperGuideClient {
  const state: ClientState = {
    status: "ready",
    conversationId: null,
    turnId: null,
    running: false,
    messages: [],
    conversations: [],
    streamingText: "",
    steps: [],
    confirmation: null,
    escalation: null,
    notice: null,
    config: null,
  };

  return {
    state,
    subscribe: (listener: (value: ClientState) => void) => {
      listener(state);
      return () => undefined;
    },
    send: vi.fn(),
    decideConfirmation: vi.fn(),
    cancel: vi.fn(),
    identify: vi.fn(),
    registerCapabilities: vi.fn(),
    reportNavigation: vi.fn(),
    reconnect: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    start: vi.fn(),
    newChat: vi.fn(),
    openConversation: vi.fn(),
    refreshHistory: vi.fn(),
  } as unknown as SuperGuideClient;
}

function panelExists(): boolean {
  // Closed shadow is unreachable; host.shadowRoot === null is the only page-visible handle.
  const host = document.getElementById(SHADOW_HOST_ID);
  return host !== null && host.shadowRoot === null;
}

describe("mounting the widget", () => {
  it("attaches a closed shadow root and leaves the host document alone", () => {
    document.body.innerHTML = `<main><h1>Northwind</h1></main>`;
    const widget = mountWidget({ client: stubClient(), document });

    expect(panelExists()).toBe(true);
    expect(document.querySelector("main h1")?.textContent).toBe("Northwind");

    widget.unmount();
    expect(document.getElementById(SHADOW_HOST_ID)).toBeNull();
  });

  it("opens and closes a widget that is already mounted", () => {
    document.body.innerHTML = "";
    const widget = mountWidget({ client: stubClient(), document, initiallyOpen: false });

    // Open was seeded from a prop; a second open() re-rendered the initial value and no-op'd.
    expect(() => {
      widget.open();
      widget.open();
      widget.close();
      widget.open();
    }).not.toThrow();

    widget.unmount();
  });

  it("replaces an earlier mount rather than stacking a second one", () => {
    document.body.innerHTML = "";
    const first = mountWidget({ client: stubClient(), document });
    const second = mountWidget({ client: stubClient(), document });

    expect(document.querySelectorAll(`#${SHADOW_HOST_ID}`)).toHaveLength(1);

    first.unmount();
    second.unmount();
  });

  it("does not leak pointer or focus events that would dismiss a host modal", () => {
    document.body.innerHTML = "";
    const widget = mountWidget({ client: stubClient(), document, initiallyOpen: true });
    const host = document.getElementById(SHADOW_HOST_ID);
    expect(host).not.toBeNull();

    let leaked = 0;
    const count = (): void => {
      leaked += 1;
    };
    document.addEventListener("pointerdown", count);
    document.addEventListener("mousedown", count);
    document.addEventListener("click", count);
    document.addEventListener("focusin", count);
    document.addEventListener("wheel", count);

    for (const type of ["pointerdown", "mousedown", "click", "focusin", "wheel"] as const) {
      host?.dispatchEvent(new Event(type, { bubbles: true, composed: true, cancelable: true }));
    }

    document.removeEventListener("pointerdown", count);
    document.removeEventListener("mousedown", count);
    document.removeEventListener("click", count);
    document.removeEventListener("focusin", count);
    document.removeEventListener("wheel", count);

    expect(leaked).toBe(0);
    widget.unmount();
  });

  it("does not leak composer keystrokes to the page", () => {
    document.documentElement.className = "dark";
    const widget = mountWidget({ client: stubClient(), document, initiallyOpen: true });
    const host = document.getElementById(SHADOW_HOST_ID);
    expect(host?.getAttribute("contenteditable")).toBe("true");
    expect(host?.dataset.sgTheme).toBe("dark");
    let leaked = 0;
    const onKey = (): void => {
      leaked += 1;
    };
    document.addEventListener("keydown", onKey);
    host?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true, composed: true }),
    );
    document.removeEventListener("keydown", onKey);
    expect(leaked).toBe(0);
    widget.unmount();
  });
});
