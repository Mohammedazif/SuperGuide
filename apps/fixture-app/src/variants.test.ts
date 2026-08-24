// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PageObserver } from "@superguide/observer";
import { ActionExecutor, type CapabilityRegistry, type Navigator } from "@superguide/executor";
import { seedState, SEED_ACCOUNT_ID } from "./data.js";
import { renderPage, type PageModel, type Variant } from "./ui.js";

function model(variant: Variant, path: string): PageModel {
  const state = seedState();
  const account = state.accounts.get(SEED_ACCOUNT_ID);
  const sso = state.sso.get(SEED_ACCOUNT_ID);
  if (account === undefined || sso === undefined) throw new Error("missing seed");

  return {
    variant,
    title: path,
    path,
    account,
    seats: [...state.seats.values()],
    invoices: [...state.invoices.values()],
    sso,
    widgetScriptUrl: null,
    widgetProductId: null,
    apiUrl: null,
  };
}

function load(variant: Variant, path: string): Document {
  const html = renderPage(model(variant, path));
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, "").replace(/<\/html>\s*$/, "");
  return document;
}

const emptyCapabilities: CapabilityRegistry = { get: () => null, names: () => [] };

function navigatorFor(url: string): Navigator {
  return { navigate: () => undefined, currentUrl: () => url };
}

function namesFor(variant: Variant, path: string): { role: string; name: string }[] {
  load(variant, path);
  const digest = new PageObserver().observe(document);
  return digest.elements
    .map((element) => ({ role: element.role, name: element.name }))
    .sort((left, right) => `${left.role}${left.name}`.localeCompare(`${right.role}${right.name}`));
}

describe("the two interface variants", () => {
  it("differ in markup and class names", () => {
    const a = renderPage(model("a", "/settings/billing"));
    const b = renderPage(model("b", "/settings/billing"));
    expect(a).not.toBe(b);
    expect(a).toContain('class="input"');
    expect(b).toContain('class="c-form__input"');
    expect(b).toContain("c-panel");
    expect(a).not.toContain("c-panel");
  });

  it("present the same semantics to the observer on every page", () => {
    for (const path of ["/account", "/settings/billing", "/settings/seats", "/settings/sso", "/invoices"]) {
      expect({ path, elements: namesFor("b", path) }).toEqual({
        path,
        elements: namesFor("a", path),
      });
    }
  });

  it("lets a grounded action finish the registration task on both variants", async () => {
    for (const variant of ["a", "b"] as const) {
      load(variant, "/account");

      const observer = new PageObserver();
      const executor = new ActionExecutor({
        document,
        observer,
        capabilities: emptyCapabilities,
        navigator: navigatorFor("https://app.example/account"),
        routeTemplates: new Map(),
        groundedActionsEnabled: true,
        settle: { quietPeriodMs: 5, ceilingMs: 60 },
      });

      const digest = observer.observe(document);
      const field = digest.elements.find(
        (element) => element.name === "Company registration number",
      );
      const save = digest.elements.find((element) => element.name === "Save registration");
      expect({ variant, field: field !== undefined, save: save !== undefined }).toEqual({
        variant,
        field: true,
        save: true,
      });
      if (field === undefined || save === undefined) continue;

      const typed = await executor.execute({
        type: "set_value",
        toolCallId: "toolu_1",
        intent: "Type the registration number.",
        expect: [{ kind: "capability_status", status: "ok" }],
        risk: "write",
        timeoutMs: 5000,
        ref: field.ref,
        value: "SC441122",
      });
      expect({ variant, status: typed.status }).toEqual({ variant, status: "ok" });

      const input = document.getElementById("registration_number");
      expect(input instanceof HTMLInputElement ? input.value : null).toBe("SC441122");

      const submitted: Record<string, unknown>[] = [];
      const form = document.getElementById("registration-form");
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
        const control = document.getElementById("registration_number");
        submitted.push({
          registration_number: control instanceof HTMLInputElement ? control.value : null,
        });
        const status = document.getElementById("registration-status");
        if (status !== null) status.textContent = "Saved";
      });

      const clicked = await executor.execute({
        type: "click",
        toolCallId: "toolu_2",
        intent: "Save the registration number.",
        expect: [{ kind: "element_state", role: "status", nameContains: "Saved" }],
        risk: "write",
        timeoutMs: 5000,
        ref: save.ref,
      });

      expect({ variant, status: clicked.status }).toEqual({ variant, status: "ok" });
      expect({ variant, submitted }).toEqual({
        variant,
        submitted: [{ registration_number: "SC441122" }],
      });

      const confirmation = clicked.status === "ok" ? clicked.digest : null;
      expect(
        confirmation?.elements.some(
          (element) => element.role === "status" && element.name.includes("Saved"),
        ),
      ).toBe(true);
    }
  });
});
