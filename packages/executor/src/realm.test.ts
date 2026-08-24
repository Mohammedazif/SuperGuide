// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { asInput, PageObserver } from "@superguide/observer";
import { ActionExecutor, type CapabilityRegistry, type Navigator } from "./index.js";

const capabilities: CapabilityRegistry = { get: () => null, names: () => [] };
const navigator: Navigator = {
  navigate: () => undefined,
  currentUrl: () => "https://app.example/settings/billing",
};

function frameDocument(inner: string): Document {
  document.body.innerHTML = `<iframe id="inner"></iframe>`;
  const frame = document.getElementById("inner");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("no frame");
  const doc = frame.contentDocument;
  if (doc === null) throw new Error("the frame has no document");
  doc.body.innerHTML = inner;
  return doc;
}

describe("acting on an element inside a same-origin frame", () => {
  it("sets a value there and fires the events a framework listens for", async () => {
    const inner = frameDocument(`
      <label for="pc">Postal code</label>
      <input id="pc" name="postal_code" value="BS1 4TT">
    `);

    const observer = new PageObserver();
    const executor = new ActionExecutor({
      document,
      observer,
      capabilities,
      navigator,
      routeTemplates: new Map(),
      groundedActionsEnabled: true,
      settle: { quietPeriodMs: 5, ceilingMs: 50 },
    });

    const field = observer
      .observe(document)
      .elements.find((element) => element.name === "Postal code");
    expect(field).toBeDefined();
    if (field === undefined) return;

    const control = asInput(inner.getElementById("pc"));
    if (control === null) throw new Error("no control");

    const seen: string[] = [];
    control.addEventListener("input", () => seen.push("input"));
    control.addEventListener("change", () => seen.push("change"));

    const outcome = await executor.execute({
      type: "set_value",
      toolCallId: "toolu_1",
      intent: "Type into the framed field.",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 5000,
      ref: field.ref,
      value: "EH3 9DR",
    });

    expect(outcome.status).toBe("ok");
    expect(control.value).toBe("EH3 9DR");
    expect(seen).toEqual(["input", "change"]);
  });

  it("toggles a checkbox and presses a key inside the frame", async () => {
    const inner = frameDocument(`
      <label for="sso">Require single sign-on</label>
      <input id="sso" name="sso" type="checkbox">
    `);

    const observer = new PageObserver();
    const executor = new ActionExecutor({
      document,
      observer,
      capabilities,
      navigator,
      routeTemplates: new Map(),
      groundedActionsEnabled: true,
      settle: { quietPeriodMs: 5, ceilingMs: 50 },
    });

    const toggle = observer
      .observe(document)
      .elements.find((element) => element.role === "checkbox");
    expect(toggle).toBeDefined();
    if (toggle === undefined) return;

    const checked = await executor.execute({
      type: "set_checked",
      toolCallId: "toolu_2",
      intent: "Turn single sign-on on.",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 5000,
      ref: toggle.ref,
      checked: true,
    });

    expect(checked.status).toBe("ok");
    const control = inner.getElementById("sso");
    expect(control?.getAttribute("id")).toBe("sso");
    expect(asInput(control)?.checked).toBe(true);

    const keys: string[] = [];
    control?.addEventListener("keydown", (event) => {
      keys.push(event.key);
    });

    const pressed = await executor.execute({
      type: "press_key",
      toolCallId: "toolu_3",
      intent: "Press enter.",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 5000,
      ref: toggle.ref,
      key: "Enter",
    });

    expect(pressed.status).toBe("ok");
    expect(keys).toEqual(["Enter"]);
  });
});
