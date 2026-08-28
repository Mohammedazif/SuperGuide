// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { asFrame, asInput, asSelect, asTextArea, isElementOfType } from "./realm.js";
import { PageObserver } from "./digest.js";

function withSameOriginFrame(inner: string): HTMLIFrameElement {
  document.body.innerHTML = `<button>Outside the frame</button><iframe id="inner"></iframe>`;
  const frame = document.getElementById("inner");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("no frame");

  const doc = frame.contentDocument;
  if (doc === null) throw new Error("the frame has no document");
  doc.body.innerHTML = inner;
  return frame;
}

describe("resolving constructors from an element's own realm", () => {
  it("recognises an element that belongs to a frame's realm", () => {
    const frame = withSameOriginFrame(`<input id="field" name="postal_code" value="BS1 4TT">`);
    const inner = frame.contentDocument?.getElementById("field");
    expect(inner).toBeDefined();
    if (inner === null || inner === undefined) return;

    // Frame elements are not instances of the top window's constructors.
    expect(inner instanceof HTMLInputElement).toBe(false);
    expect(asInput(inner)).not.toBeNull();
    expect(isElementOfType(inner, "HTMLInputElement")).toBe(true);
  });

  it("still recognises an element in the top document", () => {
    document.body.innerHTML = `
      <input id="a"><textarea id="b"></textarea><select id="c"></select><iframe id="d"></iframe>
    `;
    expect(asInput(document.getElementById("a"))).not.toBeNull();
    expect(asTextArea(document.getElementById("b"))).not.toBeNull();
    expect(asSelect(document.getElementById("c"))).not.toBeNull();
    expect(asFrame(document.getElementById("d"))).not.toBeNull();
  });

  it("refuses anything that is not an element of that type", () => {
    document.body.innerHTML = `<input id="a">`;
    expect(asSelect(document.getElementById("a"))).toBeNull();
    expect(asInput(null)).toBeNull();
    expect(asInput("not an element")).toBeNull();
    expect(asInput({ ownerDocument: { defaultView: null } })).toBeNull();
    expect(isElementOfType({ ownerDocument: {} }, "HTMLInputElement")).toBe(false);
  });

  it("digests a control inside a same-origin frame, with its value under the allowlist", () => {
    withSameOriginFrame(`
      <label for="pc">Postal code</label>
      <input id="pc" name="postal_code" value="BS1 4TT">
      <input id="pw" name="password" type="password" value="not-a-real-password">
    `);

    const digest = new PageObserver().observe(document, { valueAllowlist: ["postal_code", "password"] });
    const field = digest.elements.find((element) => element.name === "Postal code");

    expect(field).toBeDefined();
    expect(field?.value).toBe("BS1 4TT");
    expect(digest.elements.some((element) => element.name === "Outside the frame")).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("not-a-real-password");
  });

  it("does not throw when a frame refuses to hand over its document", () => {
    document.body.innerHTML = `<button>Still here</button><iframe id="hostile"></iframe>`;
    const frame = document.getElementById("hostile");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("no frame");

    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new Error("cross-origin");
      },
    });

    const digest = new PageObserver().observe(document);
    expect(digest.elements.some((element) => element.name === "Still here")).toBe(true);
  });
});
