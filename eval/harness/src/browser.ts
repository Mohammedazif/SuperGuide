import { JSDOM } from "jsdom";
import type { ExecutorAction, ToolResultPayload } from "@superguide/contract/public";
import { PageObserver } from "@superguide/observer";
import { ActionExecutor, type CapabilityRegistry, type Navigator } from "@superguide/executor";

export interface SimulatedBrowserOptions {
  fixtureUrl: string;
  startPath: string;
  variant: "a" | "b";
  valueAllowlist: readonly string[];
  routeTemplates: ReadonlyMap<string, string>;
  capabilities: CapabilityRegistry;
  groundedActionsEnabled: boolean;
}

export class SimulatedBrowser {
  #dom: JSDOM;
  #observer = new PageObserver();
  #executor: ActionExecutor;
  #url: string;
  readonly #options: SimulatedBrowserOptions;

  private constructor(dom: JSDOM, url: string, options: SimulatedBrowserOptions) {
    this.#dom = dom;
    this.#url = url;
    this.#options = options;
    this.#executor = this.#buildExecutor();
  }

  static async open(options: SimulatedBrowserOptions): Promise<SimulatedBrowser> {
    const url = SimulatedBrowser.#resolve(options.fixtureUrl, options.startPath, options.variant);
    const dom = await SimulatedBrowser.#load(url);
    return new SimulatedBrowser(dom, url, options);
  }

  static #resolve(fixtureUrl: string, path: string, variant: "a" | "b"): string {
    const url = new URL(path, fixtureUrl);
    if (variant === "b") url.searchParams.set("variant", "b");
    return url.toString();
  }

  static async #load(url: string): Promise<JSDOM> {
    const response = await fetch(url, { headers: { accept: "text/html" } });
    const html = await response.text();
    return new JSDOM(html, { url, pretendToBeVisual: true });
  }

  #buildExecutor(): ActionExecutor {
    const navigator: Navigator = {
      navigate: async (target: string) => {
        const resolved = new URL(target, this.#url);
        if (this.#options.variant === "b") resolved.searchParams.set("variant", "b");
        this.#url = resolved.toString();
        this.#dom.window.close();
        this.#dom = await SimulatedBrowser.#load(this.#url);
        this.#observer = new PageObserver();
        this.#executor = this.#buildExecutor();
      },
      currentUrl: () => this.#url,
    };

    return new ActionExecutor({
      document: this.#dom.window.document,
      observer: this.#observer,
      observeOptions: { valueAllowlist: this.#options.valueAllowlist },
      capabilities: this.#options.capabilities,
      navigator,
      routeTemplates: this.#options.routeTemplates,
      groundedActionsEnabled: this.#options.groundedActionsEnabled,
      settle: { quietPeriodMs: 10, ceilingMs: 200 },
    });
  }

  get url(): string {
    return this.#url;
  }

  digest(): ReturnType<PageObserver["observe"]> {
    return this.#observer.observe(this.#dom.window.document, {
      valueAllowlist: this.#options.valueAllowlist,
    });
  }

  // jsdom does not run form fetch; submit here so grounded actions hit the customer's API.
  async #submitForms(): Promise<void> {
    const document = this.#dom.window.document;
    for (const form of document.querySelectorAll("form[data-submitted='pending']")) {
      form.setAttribute("data-submitted", "done");
      const accountId = form.getAttribute("data-account");
      if (accountId === null) continue;

      const values: Record<string, unknown> = {};
      for (const control of form.querySelectorAll("input")) {
        const name = control.getAttribute("id");
        if (name === null) continue;
        values[name] = control.type === "checkbox" ? control.checked : control.value;
      }

      const id = form.getAttribute("id");
      if (id === null) continue;
      const request =
        id === "billing-form"
          ? {
              path: `/api/v1/accounts/${accountId}/billing-address`,
              method: "PATCH",
              body: {
                line1: values["line1"],
                line2: values["line2"] === "" ? null : values["line2"],
                city: values["city"],
                postal_code: values["postal_code"],
                country: values["country"],
              },
            }
          : id === "sso-form"
            ? {
                path: `/api/v1/accounts/${accountId}/sso`,
                method: "PUT",
                body: {
                  enabled: values["sso_enabled"] === true,
                  enforced_domain: values["enforced_domain"] === "" ? null : values["enforced_domain"],
                },
              }
            : id === "registration-form"
              ? {
                  path: `/internal-ui/accounts/${accountId}/registration`,
                  method: "POST",
                  body: { registration_number: values["registration_number"] },
                }
              : null;

      if (request === null) continue;

      const response = await fetch(new URL(request.path, this.#options.fixtureUrl), {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });

      const status = document.getElementById(`${id.replace("-form", "")}-status`);
      if (status !== null) status.textContent = response.ok ? "Saved" : "Could not save";
    }
  }

  async perform(action: ExecutorAction): Promise<ToolResultPayload> {
    if (action.type === "click") {
      const element = this.#observer.resolve(action.ref);
      const form = element?.closest("form");
      if (form !== null && form !== undefined && element?.getAttribute("type") === "submit") {
        form.setAttribute("data-submitted", "pending");
      }
    }

    const outcome = await this.#executor.execute(action);
    await this.#submitForms();

    if (outcome.status === "ok") {
      return { status: "ok", data: outcome.data, digest: this.digest(), url: this.#url };
    }
    return { status: "failed", error: outcome.error, digest: this.digest(), url: this.#url };
  }

  close(): void {
    this.#dom.window.close();
  }
}
