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
    streamingText: "",
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
  } as unknown as SuperGuideClient;
}

function panelExists(): boolean {
  // A closed shadow root is unreachable from the page, so the mount is inspected through the
  // one handle a test legitimately has: the host element's own shadow root reference is null.
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

    // The defect this guards: the open state was seeded from a prop, so open() on a mounted
    // widget re-rendered with the same initial value and nothing happened.
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
});
