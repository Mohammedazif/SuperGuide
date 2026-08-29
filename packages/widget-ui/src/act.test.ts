// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActLayer } from "./act.js";

describe("the act layer", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function mount(onStop: () => void = () => undefined) {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const act = createActLayer(document, shadow, host, onStop);
    return { host, shadow, act };
  }

  it("shows the status pill and Stop while locked", () => {
    let stopped = 0;
    const { shadow, act } = mount(() => {
      stopped += 1;
    });
    act.setLocked(true);
    const pill = shadow.querySelector("[role='status']");
    expect(pill?.textContent).toContain("SuperGuide is running");
    const stop = [...shadow.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop",
    );
    expect(stop).toBeDefined();
    stop?.click();
    expect(stopped).toBe(1);
    act.remove();
  });

  it("draws and removes a highlight ring", async () => {
    vi.useFakeTimers();
    const { act } = mount();
    const target = document.createElement("button");
    target.style.cssText = "position:fixed;top:10px;left:10px;width:40px;height:40px";
    document.body.append(target);
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ top: 10, left: 10, width: 40, height: 40, bottom: 50, right: 50 }),
    });
    act.setLocked(true);
    const pending = act.highlight(target);
    await vi.advanceTimersByTimeAsync(450);
    await vi.advanceTimersByTimeAsync(220);
    await pending;
    act.remove();
  });
});
