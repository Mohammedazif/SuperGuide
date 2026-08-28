import {
  EXECUTOR_ACTION_TYPES,
  executorActionSchema,
  type ClientErrorCode,
  type ExecutorAction,
  type PageDigest,
} from "@superguide/contract/public";
import { asInput, asSelect, asTextArea, type ObserveOptions, type PageObserver } from "@superguide/observer";
import { DEFAULT_SETTLE, waitForSettle } from "./settle.js";
import type {
  CapabilityRegistry,
  ExecutionOutcome,
  Navigator,
  SettleOptions,
} from "./types.js";

export interface ExecutorOptions {
  document: Document;
  observer: PageObserver;
  observeOptions?: ObserveOptions;
  capabilities: CapabilityRegistry;
  navigator: Navigator;
  routeTemplates: ReadonlyMap<string, string>;
  groundedActionsEnabled: boolean;
  settle?: SettleOptions;
}

function failure(
  code: ClientErrorCode,
  message: string,
  digest: PageDigest | null,
  url: string,
): ExecutionOutcome {
  return { status: "failed", error: { code, message }, digest, url };
}

function isMutating(action: ExecutorAction): boolean {
  switch (action.type) {
    case "click":
    case "set_value":
    case "select_option":
    case "set_checked":
    case "press_key":
      return true;
    case "scroll":
    case "hover":
    case "wait_for":
    case "navigate_route":
    case "invoke_capability":
      return false;
    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function isGrounded(action: ExecutorAction): boolean {
  return action.type !== "navigate_route" && action.type !== "invoke_capability";
}

// Frameworks observe value via the prototype setter; assigning the property is invisible to them.
function setValueObservably(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = element.ownerDocument.defaultView;
  const prototype =
    asTextArea(element) !== null
      ? (view?.HTMLTextAreaElement.prototype ?? null)
      : (view?.HTMLInputElement.prototype ?? null);

  const descriptor =
    prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set !== undefined) descriptor.set.call(element, value);
  else element.value = value;

  const EventConstructor = view?.Event ?? Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

function fillRouteTemplate(
  template: string,
  params: Record<string, string>,
): { ok: true; path: string } | { ok: false; missing: string } {
  let path = template;
  const placeholders = template.match(/\{([^}]+)\}/g) ?? [];

  for (const placeholder of placeholders) {
    const key = placeholder.slice(1, -1);
    const value = params[key];
    if (value === undefined) return { ok: false, missing: key };
    path = path.replace(placeholder, encodeURIComponent(value));
  }
  return { ok: true, path };
}

export class ActionExecutor {
  #options: ExecutorOptions;

  constructor(options: ExecutorOptions) {
    this.#options = options;
  }

  setGroundedActionsEnabled(enabled: boolean): void {
    this.#options = { ...this.#options, groundedActionsEnabled: enabled };
  }

  setObserveOptions(observeOptions: ObserveOptions): void {
    this.#options = { ...this.#options, observeOptions };
  }

  digest(): PageDigest {
    return this.#options.observer.observe(this.#options.document, this.#options.observeOptions ?? {});
  }

  async execute(candidate: unknown): Promise<ExecutionOutcome> {
    const url = this.#options.navigator.currentUrl();

    // Closed vocabulary: refuse unknown actions before dispatch, digest, or any handler.
    const parsed = executorActionSchema.safeParse(candidate);
    if (!parsed.success) {
      const type =
        typeof candidate === "object" && candidate !== null && "type" in candidate
          ? String(candidate.type)
          : "<absent>";
      const known = (EXECUTOR_ACTION_TYPES as readonly string[]).includes(type);
      return failure(
        "UNKNOWN_ACTION",
        known
          ? `the action ${type} did not match its declared shape`
          : `${type} is not an action this executor performs`,
        null,
        url,
      );
    }

    const action = parsed.data;

    if (isGrounded(action) && !this.#options.groundedActionsEnabled) {
      return failure(
        "GROUNDED_ACTIONS_DISABLED",
        "operating the interface directly is switched off",
        null,
        url,
      );
    }

    try {
      const outcome = await this.#dispatch(action, url);
      if (outcome.status === "ok" && isMutating(action)) {
        await waitForSettle(this.#options.document, this.#options.settle ?? DEFAULT_SETTLE);
        return { ...outcome, digest: this.digest(), url: this.#options.navigator.currentUrl() };
      }
      return outcome;
    } catch (error) {
      return failure(
        "CAPABILITY_THREW",
        error instanceof Error ? error.message : String(error),
        null,
        this.#options.navigator.currentUrl(),
      );
    }
  }

  #resolve(ref: string, url: string): { ok: true; element: Element } | { ok: false; outcome: ExecutionOutcome } {
    const element = this.#options.observer.resolve(ref);
    if (element === null) {
      return {
        ok: false,
        outcome: failure(
          "STALE_REF",
          `${ref} no longer points at an element on this page`,
          this.digest(),
          url,
        ),
      };
    }
    if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
      return {
        ok: false,
        outcome: failure("ELEMENT_DISABLED", `${ref} is disabled`, this.digest(), url),
      };
    }
    return { ok: true, element };
  }

  async #dispatch(action: ExecutorAction, url: string): Promise<ExecutionOutcome> {
    switch (action.type) {
      case "click": {
        const resolved = this.#resolve(action.ref, url);
        if (!resolved.ok) return resolved.outcome;
        (resolved.element as HTMLElement).click();
        return { status: "ok", data: { clicked: action.ref }, digest: null, url };
      }

      case "set_value": {
        const resolved = this.#resolve(action.ref, url);
        if (!resolved.ok) return resolved.outcome;
        const field = asInput(resolved.element) ?? asTextArea(resolved.element);
        if (field === null) {
          return failure("ELEMENT_NOT_FOUND", `${action.ref} is not a text field`, this.digest(), url);
        }
        setValueObservably(field, action.value);
        return { status: "ok", data: { ref: action.ref }, digest: null, url };
      }

      case "select_option": {
        const resolved = this.#resolve(action.ref, url);
        if (!resolved.ok) return resolved.outcome;
        const select = asSelect(resolved.element);
        if (select === null) {
          return failure("ELEMENT_NOT_FOUND", `${action.ref} is not a select`, this.digest(), url);
        }
        const match = [...select.options].find(
          (option) => option.value === action.value || option.label === action.value,
        );
        if (match === undefined) {
          return failure(
            "ELEMENT_NOT_FOUND",
            `${action.ref} has no option ${action.value}`,
            this.digest(),
            url,
          );
        }
        const selectView = select.ownerDocument.defaultView;
        const SelectEvent = selectView?.Event ?? Event;
        select.value = match.value;
        select.dispatchEvent(new SelectEvent("input", { bubbles: true }));
        select.dispatchEvent(new SelectEvent("change", { bubbles: true }));
        return { status: "ok", data: { ref: action.ref, value: match.value }, digest: null, url };
      }

      case "set_checked": {
        const resolved = this.#resolve(action.ref, url);
        if (!resolved.ok) return resolved.outcome;
        const checkbox = asInput(resolved.element);
        if (checkbox === null) {
          return failure("ELEMENT_NOT_FOUND", `${action.ref} is not a checkbox`, this.digest(), url);
        }
        if (checkbox.checked !== action.checked) checkbox.click();
        return { status: "ok", data: { ref: action.ref, checked: action.checked }, digest: null, url };
      }

      case "press_key": {
        let target: Element = this.#options.document.body;
        if (action.ref !== undefined) {
          const resolved = this.#resolve(action.ref, url);
          if (!resolved.ok) return resolved.outcome;
          target = resolved.element;
        }
        const keyView = target.ownerDocument.defaultView;
        const KeyboardEventConstructor = keyView?.KeyboardEvent ?? KeyboardEvent;
        for (const type of ["keydown", "keypress", "keyup"] as const) {
          target.dispatchEvent(
            new KeyboardEventConstructor(type, { key: action.key, bubbles: true, cancelable: true }),
          );
        }
        return { status: "ok", data: { key: action.key }, digest: null, url };
      }

      case "scroll": {
        const view = this.#options.document.defaultView;
        const amount = action.amount ?? 400;
        const delta = action.direction === "down" ? amount : -amount;
        if (action.ref !== undefined) {
          const resolved = this.#resolve(action.ref, url);
          if (!resolved.ok) return resolved.outcome;
          resolved.element.scrollTop += delta;
        } else if (view !== null) {
          view.scrollBy(0, delta);
        }
        return { status: "ok", data: { scrolled: delta }, digest: this.digest(), url };
      }

      case "hover": {
        const resolved = this.#resolve(action.ref, url);
        if (!resolved.ok) return resolved.outcome;
        const hoverView = resolved.element.ownerDocument.defaultView;
        const HoverEvent = hoverView?.Event ?? Event;
        for (const type of ["pointerover", "mouseover", "mouseenter"] as const) {
          resolved.element.dispatchEvent(new HoverEvent(type, { bubbles: type !== "mouseenter" }));
        }
        await waitForSettle(this.#options.document, this.#options.settle ?? DEFAULT_SETTLE);
        return { status: "ok", data: { ref: action.ref }, digest: this.digest(), url };
      }

      case "wait_for": {
        const deadline = action.timeoutMs;
        const startedAt = Date.now();
        const needle = action.nameContains.toLowerCase();

        for (;;) {
          const digest = this.digest();
          const found = digest.elements.some(
            (element) =>
              element.role === action.role && element.name.toLowerCase().includes(needle),
          );
          if (found) return { status: "ok", data: { waited: true }, digest, url };
          if (Date.now() - startedAt > deadline) {
            return failure(
              "TIMEOUT",
              `no ${action.role} named like ${action.nameContains} appeared`,
              digest,
              url,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      case "navigate_route": {
        const template = this.#options.routeTemplates.get(action.routeId);
        if (template === undefined) {
          return failure(
            "ROUTE_UNKNOWN",
            `${action.routeId} is not a route this product declared`,
            null,
            url,
          );
        }
        const filled = fillRouteTemplate(template, action.params);
        if (!filled.ok) {
          return failure(
            "ROUTE_UNKNOWN",
            `the route needs a value for ${filled.missing}`,
            null,
            url,
          );
        }
        await this.#options.navigator.navigate(filled.path);
        const after = this.#options.navigator.currentUrl();
        return { status: "ok", data: { route: action.routeId }, digest: this.digest(), url: after };
      }

      case "invoke_capability": {
        const capability = this.#options.capabilities.get(action.capability);
        if (capability === null) {
          return failure(
            "CAPABILITY_NOT_REGISTERED",
            `${action.capability} is not registered on this page`,
            null,
            url,
          );
        }

        const validated = capability.parse(action.arguments);
        if (!validated.success) {
          return failure("CAPABILITY_ARGS_INVALID", validated.message, null, url);
        }

        const result = await capability.handler(validated.data);
        if (result.status === "failed") {
          return failure(
            "CAPABILITY_THREW",
            result.message ?? "the capability reported a failure",
            null,
            this.#options.navigator.currentUrl(),
          );
        }
        return {
          status: "ok",
          data: result.data ?? null,
          digest: null,
          url: this.#options.navigator.currentUrl(),
        };
      }

      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
