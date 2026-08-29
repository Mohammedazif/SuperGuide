// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { accessibleName } from "./accessible-name.js";
import { diff, PageObserver } from "./digest.js";
import { stableIdentifier } from "./refs.js";

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe("accessible name derivation", () => {
  it("prefers an associated label over every other source", () => {
    render(`
      <label for="city">City</label>
      <input id="city" name="city_name" aria-label="Aria city" title="Title city" placeholder="Placeholder city">
    `);
    const input = document.getElementById("city");
    expect(input).not.toBeNull();
    if (input === null) return;
    expect(accessibleName(input)).toBe("City");
  });

  it("falls back through aria-label, aria-labelledby, title, placeholder, then name", () => {
    render(`
      <input id="a" aria-label="From aria label" title="t" placeholder="p" name="n">
      <span id="lb">From labelledby</span>
      <input id="b" aria-labelledby="lb" title="t" placeholder="p" name="n">
      <input id="c" title="From title" placeholder="p" name="n">
      <input id="d" placeholder="From placeholder" name="n">
      <input id="e" name="from_name">
    `);
    const named = (id: string): string => {
      const element = document.getElementById(id);
      return element === null ? "" : accessibleName(element);
    };
    expect(named("a")).toBe("From aria label");
    expect(named("b")).toBe("From labelledby");
    expect(named("c")).toBe("From title");
    expect(named("d")).toBe("From placeholder");
    expect(named("e")).toBe("from_name");
  });

  it("reads a wrapping label without swallowing the control's own value", () => {
    render(`<label>Postal code <input id="pc" value="BS1 4TT"></label>`);
    const input = document.getElementById("pc");
    if (input === null) throw new Error("missing input");
    expect(accessibleName(input)).toBe("Postal code");
  });

  it("collapses whitespace", () => {
    render(`<button id="b">  Save    changes\n</button>`);
    const button = document.getElementById("b");
    if (button === null) throw new Error("missing button");
    expect(accessibleName(button)).toBe("Save changes");
  });
});

describe("the page digest", () => {
  let observer: PageObserver;

  beforeEach(() => {
    observer = new PageObserver();
  });

  it("omits field values by default", () => {
    render(`
      <label for="pc">Postal code</label>
      <input id="pc" name="postal_code" value="BS1 4TT">
    `);
    const digest = observer.observe(document);
    const field = digest.elements.find((element) => element.name === "Postal code");
    expect(field).toBeDefined();
    expect(field?.value).toBeUndefined();
  });

  it("includes a value only when the product's allowlist names the field", () => {
    render(`
      <label for="pc">Postal code</label>
      <input id="pc" name="postal_code" value="BS1 4TT">
    `);
    const digest = observer.observe(document, { valueAllowlist: ["postal_code"] });
    const field = digest.elements.find((element) => element.name === "Postal code");
    expect(field?.value).toBe("BS1 4TT");
  });

  it("never includes a password field's value under any configuration", () => {
    render(`
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" value="not-a-real-password">
    `);
    const digest = observer.observe(document, {
      valueAllowlist: ["password", "pw", "*"],
    });
    const field = digest.elements.find((element) => element.name === "Password");
    expect(field).toBeDefined();
    expect(field?.value).toBeUndefined();
    expect(JSON.stringify(digest)).not.toContain("not-a-real-password");
  });

  it("reports headings, landmarks, and element state", () => {
    render(`
      <header><h1>Northwind</h1></header>
      <nav aria-label="Main"><a href="/a">Account</a></nav>
      <main>
        <h2>Single sign-on</h2>
        <label for="sso">Require single sign-on</label>
        <input id="sso" type="checkbox" checked>
        <button disabled>Save</button>
      </main>
    `);
    const digest = observer.observe(document);
    expect(digest.headings).toContain("Northwind");
    expect(digest.headings).toContain("Single sign-on");
    expect(digest.landmarks.some((entry) => entry.startsWith("navigation"))).toBe(true);

    const toggle = digest.elements.find((element) => element.role === "checkbox");
    expect(toggle?.state?.checked).toBe(true);

    const save = digest.elements.find((element) => element.name === "Save");
    expect(save?.state?.disabled).toBe(true);
  });

  it("keeps an open dialog's controls instead of the crowded page behind it", () => {
    const cards = Array.from({ length: 40 }, (_, index) => `<button>Row ${index}</button>`).join("");
    render(`
      <main>${cards}</main>
      <div role="dialog" aria-label="Account settings">
        <label for="display-name">Display name</label>
        <input id="display-name">
        <label for="email">Email</label>
        <input id="email" type="email">
        <button>Save</button>
      </div>
    `);
    const digest = observer.observe(document, { maxElements: 10 });
    const names = digest.elements.map((element) => element.name);
    expect(names).toContain("Display name");
    expect(names).toContain("Save");
    expect(names.some((name) => /^Row \d+$/.test(name))).toBe(false);
  });

  it("treats aria-modal as an open overlay even without role=dialog", () => {
    const cards = Array.from({ length: 40 }, (_, index) => `<button>Row ${index}</button>`).join("");
    render(`
      <main>${cards}</main>
      <div aria-modal="true" aria-label="Invite teammate">
        <label for="invite-email">Teammate email</label>
        <input id="invite-email" type="email">
        <button>Send invite</button>
      </div>
    `);
    const digest = observer.observe(document, { maxElements: 8 });
    const names = digest.elements.map((element) => element.name);
    expect(names).toContain("Teammate email");
    expect(names).toContain("Send invite");
    expect(names.some((name) => /^Row \d+$/.test(name))).toBe(false);
  });

  it("scopes to a native open dialog and ignores a closed one", () => {
    const cards = Array.from({ length: 20 }, (_, index) => `<button>Row ${index}</button>`).join("");
    render(`
      <main>${cards}</main>
      <dialog>
        <label for="hidden-field">Should not appear</label>
        <input id="hidden-field">
        <button>Abandoned</button>
      </dialog>
    `);
    const closed = observer.observe(document, { maxElements: 8 });
    expect(closed.elements.map((element) => element.name)).toContain("Row 0");
    expect(closed.elements.map((element) => element.name)).not.toContain("Abandoned");

    render(`
      <main>${cards}</main>
      <dialog open>
        <label for="workspace-name">Workspace name</label>
        <input id="workspace-name">
        <button>Create workspace</button>
      </dialog>
    `);
    const opened = observer.observe(document, { maxElements: 8 });
    const names = opened.elements.map((element) => element.name);
    expect(names).toContain("Workspace name");
    expect(names).toContain("Create workspace");
    expect(names.some((name) => /^Row \d+$/.test(name))).toBe(false);
  });

  it("keeps unnamed form controls and unnamed buttons that sit inside a modal", () => {
    render(`
      <main>
        <button aria-label=""></button>
        <button>Visible page action</button>
      </main>
      <div role="dialog" aria-label="Filter results">
        <button role="combobox" aria-expanded="false"></button>
        <input>
        <button></button>
        <button>Apply filters</button>
      </div>
    `);
    const digest = observer.observe(document, { maxElements: 12 });
    const names = digest.elements.map((element) => element.name);
    expect(names).toContain("Apply filters");
    expect(names).toContain("Filter results");
    expect(names).not.toContain("Visible page action");

    const combobox = digest.elements.find((element) => element.role === "combobox");
    expect(combobox).toBeDefined();
    expect(combobox?.name).toBe("");

    const textbox = digest.elements.find((element) => element.role === "textbox");
    expect(textbox).toBeDefined();

    expect(digest.elements.some((element) => element.role === "button" && element.name === "")).toBe(
      true,
    );
  });

  it("keeps a portaled listbox that rendered outside the open dialog", () => {
    const cards = Array.from({ length: 30 }, (_, index) => `<button>Row ${index}</button>`).join("");
    render(`
      <main>${cards}</main>
      <div role="dialog" aria-label="Share document">
        <button role="combobox" aria-expanded="true" aria-label="Role">Role</button>
      </div>
      <div role="listbox" aria-label="Role options">
        <div role="option">Admin</div>
        <div role="option">Viewer</div>
      </div>
    `);
    const digest = observer.observe(document, { maxElements: 10 });
    const names = digest.elements.map((element) => element.name);
    expect(names).toContain("Role");
    expect(names).toContain("Admin");
    expect(names).toContain("Viewer");
    expect(names.some((name) => /^Row \d+$/.test(name))).toBe(false);
  });

  it("still reports unnamed comboboxes on a page with no modal", () => {
    render(`
      <label for="named">Country</label>
      <select id="named"><option>Kenya</option></select>
      <button role="combobox" aria-expanded="false"></button>
      <button></button>
    `);
    const digest = observer.observe(document);
    expect(digest.elements.some((element) => element.role === "combobox" && element.name === "")).toBe(
      true,
    );
    expect(digest.elements.some((element) => element.name === "Country")).toBe(true);
    expect(digest.elements.some((element) => element.role === "button" && element.name === "")).toBe(
      false,
    );
  });

  it("caps the element list and says so honestly", () => {
    const buttons = Array.from({ length: 30 }, (_, index) => `<button>Item ${index}</button>`).join("");
    render(buttons);
    const digest = observer.observe(document, { maxElements: 10 });
    expect(digest.elements).toHaveLength(10);
    expect(digest.truncated).toBe(true);

    const whole = observer.observe(document, { maxElements: 100 });
    expect(whole.truncated).toBe(false);
  });

  it("traverses an open shadow root", () => {
    render(`<div id="host"></div>`);
    const host = document.getElementById("host");
    if (host === null) throw new Error("missing host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>Inside the shadow root</button>`;

    const digest = observer.observe(document);
    expect(digest.elements.some((element) => element.name === "Inside the shadow root")).toBe(true);
  });

  it("mints refs that survive a re-render", () => {
    const markup = `
      <label for="city">City</label><input id="city" name="city">
      <button>Save changes</button>
    `;
    render(markup);
    const first = observer.observe(document);

    render(markup);
    const second = observer.observe(document);

    expect(second.elements.map((element) => element.ref)).toEqual(
      first.elements.map((element) => element.ref),
    );
  });

  it("resolves a ref to a live node and reports a detached one as gone", () => {
    render(`<button id="target">Save changes</button>`);
    const digest = observer.observe(document);
    const button = digest.elements.find((element) => element.name === "Save changes");
    if (button === undefined) throw new Error("missing button");

    expect(observer.resolve(button.ref)?.textContent).toBe("Save changes");

    document.getElementById("target")?.remove();
    expect(observer.resolve(button.ref)).toBeNull();
    expect(observer.resolve("e999999999")).toBeNull();
  });

  it("filters framework-generated identifiers out of a ref signature", () => {
    expect(stableIdentifier(":r3:")).toBe("");
    expect(stableIdentifier("react-aria-42")).toBe("");
    expect(stableIdentifier("radix-content-1")).toBe("");
    expect(stableIdentifier("v-9f3a2b7c")).toBe("");
    expect(stableIdentifier("billing-form")).toBe("billing-form");
  });
});

describe("digest diffing", () => {
  it("reports everything as added when there is nothing to compare against", () => {
    const observer = new PageObserver();
    render(`<button>One</button>`);
    const next = observer.observe(document);
    const result = diff(null, next);
    expect(result.added).toHaveLength(next.elements.length);
    expect(result.removed).toEqual([]);
  });

  it("reports only what changed between two observations", () => {
    const observer = new PageObserver();
    render(`
      <button>Keep</button>
      <button>Remove</button>
      <label for="c">Toggle</label><input id="c" type="checkbox">
    `);
    const before = observer.observe(document);

    render(`
      <button>Keep</button>
      <label for="c">Toggle</label><input id="c" type="checkbox" checked>
      <button>Add</button>
    `);
    const after = observer.observe(document);

    const result = diff(before, after);
    expect(result.added.map((element) => element.name)).toContain("Add");
    expect(result.changed.some((element) => element.state?.checked === true)).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.url).toBeNull();
  });
});
