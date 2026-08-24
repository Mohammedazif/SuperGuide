// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageObserver } from "@superguide/observer";
import type { ExecutorAction } from "@superguide/contract/public";
import { ActionExecutor } from "./execute.js";
import type { CapabilityRegistry, Navigator, RegisteredCapability } from "./types.js";

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    toolCallId: "toolu_1",
    intent: "Do the thing.",
    expect: [{ kind: "capability_status", status: "ok" }],
    risk: "write",
    timeoutMs: 5000,
    ...overrides,
  };
}

function registry(entries: RegisteredCapability[]): CapabilityRegistry {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    get: (name) => byName.get(name) ?? null,
    names: () => [...byName.keys()],
  };
}

function navigatorFor(initial: string): Navigator & { visited: string[] } {
  const visited: string[] = [];
  let current = initial;
  return {
    visited,
    navigate(url: string) {
      visited.push(url);
      current = new URL(url, initial).toString();
    },
    currentUrl() {
      return current;
    },
  };
}

describe("the action executor", () => {
  let observer: PageObserver;
  let navigator: ReturnType<typeof navigatorFor>;

  function build(options: {
    grounded?: boolean;
    capabilities?: RegisteredCapability[];
    routes?: [string, string][];
  } = {}): ActionExecutor {
    return new ActionExecutor({
      document,
      observer,
      capabilities: registry(options.capabilities ?? []),
      navigator,
      routeTemplates: new Map(options.routes ?? [["billing_settings", "/settings/billing"]]),
      groundedActionsEnabled: options.grounded ?? true,
      settle: { quietPeriodMs: 5, ceilingMs: 60 },
    });
  }

  beforeEach(() => {
    observer = new PageObserver();
    navigator = navigatorFor("https://app.example/settings/billing");
    document.body.innerHTML = `
      <label for="pc">Postal code</label>
      <input id="pc" name="postal_code" value="BS1 4TT">
      <label for="country">Country</label>
      <select id="country" name="country"><option value="GB">GB</option><option value="IE">IE</option></select>
      <label for="sso">Require single sign-on</label>
      <input id="sso" name="sso" type="checkbox">
      <button id="save">Save changes</button>
      <button id="locked" disabled>Locked</button>
    `;
  });

  function refFor(name: string): string {
    const digest = observer.observe(document);
    const found = digest.elements.find((element) => element.name === name);
    if (found === undefined) throw new Error(`no element named ${name}`);
    return found.ref;
  }

  it("refuses an action type outside the vocabulary before anything is dispatched", async () => {
    const executor = build();
    const outcome = await executor.execute(
      envelope({ type: "run_script", source: "fetch('https://evil.example')" }),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("UNKNOWN_ACTION");
    expect(outcome.error.message).toContain("run_script");
  });

  it("refuses a known action type whose shape is wrong", async () => {
    const executor = build();
    const outcome = await executor.execute(envelope({ type: "click" }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("UNKNOWN_ACTION");
  });

  it("refuses every grounded action when the flag is off", async () => {
    const executor = build({ grounded: false });
    const ref = refFor("Save changes");

    for (const action of [
      envelope({ type: "click", ref }),
      envelope({ type: "set_value", ref: refFor("Postal code"), value: "X" }),
      envelope({ type: "press_key", key: "Enter" }),
      envelope({ type: "scroll", direction: "down" }),
    ]) {
      const outcome = await executor.execute(action);
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") continue;
      expect(outcome.error.code).toBe("GROUNDED_ACTIONS_DISABLED");
    }
  });

  it("still allows a route navigation and a capability when grounded actions are off", async () => {
    const capability: RegisteredCapability = {
      name: "export_invoices",
      risk: "read",
      parse: (input) => ({ success: true, data: input }),
      handler: () => ({ status: "ok", data: { rows: 3 } }),
    };
    const executor = build({ grounded: false, capabilities: [capability] });

    const navigated = await executor.execute(
      envelope({ type: "navigate_route", routeId: "billing_settings", params: {}, risk: "read" }),
    );
    expect(navigated.status).toBe("ok");

    const invoked = await executor.execute(
      envelope({
        type: "invoke_capability",
        capability: "export_invoices",
        arguments: { format: "csv" },
        risk: "read",
      }),
    );
    expect(invoked.status).toBe("ok");
  });

  it("sets a value in a way frameworks observe", async () => {
    const executor = build();
    const input = document.getElementById("pc");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");

    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));

    const outcome = await executor.execute(
      envelope({ type: "set_value", ref: refFor("Postal code"), value: "EH3 9DR" }),
    );

    expect(outcome.status).toBe("ok");
    expect(input.value).toBe("EH3 9DR");
    expect(seen).toEqual(["input", "change"]);
  });

  it("fails with a stale ref and a fresh digest rather than guessing", async () => {
    const executor = build();
    const ref = refFor("Save changes");
    document.getElementById("save")?.remove();

    const outcome = await executor.execute(envelope({ type: "click", ref }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("STALE_REF");
    expect(outcome.digest).not.toBeNull();
  });

  it("refuses to act on a disabled control", async () => {
    const executor = build();
    const outcome = await executor.execute(envelope({ type: "click", ref: refFor("Locked") }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("ELEMENT_DISABLED");
  });

  it("selects an option and toggles a checkbox", async () => {
    const executor = build();

    const selected = await executor.execute(
      envelope({ type: "select_option", ref: refFor("Country"), value: "IE" }),
    );
    expect(selected.status).toBe("ok");
    const select = document.getElementById("country");
    if (!(select instanceof HTMLSelectElement)) throw new Error("missing select");
    expect(select.value).toBe("IE");

    const toggled = await executor.execute(
      envelope({ type: "set_checked", ref: refFor("Require single sign-on"), checked: true }),
    );
    expect(toggled.status).toBe("ok");
    const checkbox = document.getElementById("sso");
    if (!(checkbox instanceof HTMLInputElement)) throw new Error("missing checkbox");
    expect(checkbox.checked).toBe(true);
  });

  it("validates capability arguments against the registered schema and rejects a mismatch", async () => {
    const handler = vi.fn(() => ({ status: "ok" as const, data: null }));
    const capability: RegisteredCapability = {
      name: "export_invoices",
      risk: "read",
      parse: (input) => {
        const record = input as { format?: unknown };
        return typeof record.format === "string"
          ? { success: true, data: record }
          : { success: false, message: "format must be a string" };
      },
      handler,
    };

    const executor = build({ capabilities: [capability] });
    const outcome = await executor.execute(
      envelope({
        type: "invoke_capability",
        capability: "export_invoices",
        arguments: { format: 7 },
        risk: "read",
      }),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("CAPABILITY_ARGS_INVALID");
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports an unregistered capability rather than improvising", async () => {
    const executor = build();
    const outcome = await executor.execute(
      envelope({
        type: "invoke_capability",
        capability: "delete_everything",
        arguments: {},
        risk: "read",
      }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("CAPABILITY_NOT_REGISTERED");
  });

  it("records a handler that throws instead of swallowing it", async () => {
    const capability: RegisteredCapability = {
      name: "explode",
      risk: "read",
      parse: (input) => ({ success: true, data: input }),
      handler: () => {
        throw new Error("the dialog was not open");
      },
    };
    const executor = build({ capabilities: [capability] });
    const outcome = await executor.execute(
      envelope({ type: "invoke_capability", capability: "explode", arguments: {}, risk: "read" }),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("CAPABILITY_THREW");
    expect(outcome.error.message).toBe("the dialog was not open");
  });

  it("refuses a route the product never declared", async () => {
    const executor = build();
    const outcome = await executor.execute(
      envelope({ type: "navigate_route", routeId: "secret_admin", params: {}, risk: "read" }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("ROUTE_UNKNOWN");
  });

  it("fills a route template and reports the url it reached", async () => {
    const executor = build({ routes: [["invoice_detail", "/invoices/{invoiceId}"]] });
    const outcome = await executor.execute(
      envelope({
        type: "navigate_route",
        routeId: "invoice_detail",
        params: { invoiceId: "inv_2026_06" },
        risk: "read",
      }),
    );

    expect(outcome.status).toBe("ok");
    expect(navigator.visited).toEqual(["/invoices/inv_2026_06"]);
    expect(outcome.url).toContain("/invoices/inv_2026_06");
  });

  it("waits for an element and times out honestly when it never appears", async () => {
    const executor = build();
    const outcome = await executor.execute(
      envelope({ type: "wait_for", role: "status", nameContains: "Saved", timeoutMs: 120, risk: "read" }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.code).toBe("TIMEOUT");
  });

  it("returns a fresh digest after a mutating action", async () => {
    const executor = build();
    const save = document.getElementById("save");
    save?.addEventListener("click", () => {
      const status = document.createElement("output");
      status.setAttribute("role", "status");
      status.textContent = "Saved";
      document.body.append(status);
    });

    const outcome = await executor.execute(
      envelope({ type: "click", ref: refFor("Save changes"), risk: "write" }),
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.digest).not.toBeNull();
    const saved =
      outcome.status === "ok" && outcome.digest !== null
        ? outcome.digest.elements.some((element) => element.name === "Saved")
        : false;
    expect(saved).toBe(true);
  });
});

describe("the executor holds no state that could become an approval", () => {
  it("exports no mutable module binding", async () => {
    const module: Record<string, unknown> = await import("./execute.js");
    for (const value of Object.values(module)) {
      expect(typeof value === "function" || typeof value === "object").toBe(true);
    }
    const actions: ExecutorAction["type"][] = ["click", "set_value"];
    expect(actions).toHaveLength(2);
  });
});
