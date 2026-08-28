import type {
  AdapterRoute,
  AdapterStep,
  AgentAction,
  PageDigest,
  SiteAdapter,
} from "@superguide/contract/anywhere";
import { templatePlaceholders } from "./loader.js";

export interface AdapterParamValue {
  name: string;
  value: string;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

export function matchAdapter(
  adapters: readonly SiteAdapter[],
  host: string,
): SiteAdapter | null {
  // Exact host; highest version then smallest JSON body, independent of input order.
  const candidates = adapters
    .filter((adapter) => adapter.host === host)
    .sort((left, right) => {
      if (left.version !== right.version) return right.version - left.version;
      return JSON.stringify(left) < JSON.stringify(right) ? -1 : 1;
    });
  return candidates[0] ?? null;
}

function staticPrefixOf(template: string): string {
  const brace = template.indexOf("{");
  return brace === -1 ? template : template.slice(0, brace);
}

export function matchRoute(adapter: SiteAdapter, path: string): AdapterRoute | null {
  const candidates = adapter.routes
    .filter((route) => path.startsWith(staticPrefixOf(route.template)))
    .sort((left, right) => {
      const leftLength = staticPrefixOf(left.template).length;
      const rightLength = staticPrefixOf(right.template).length;
      if (leftLength !== rightLength) return rightLength - leftLength;
      return left.id < right.id ? -1 : 1;
    });
  return candidates[0] ?? null;
}

export function expandRouteTemplate(
  route: AdapterRoute,
  params: readonly AdapterParamValue[],
): Resolved<string> {
  const supplied = new Map(params.map((param) => [param.name, param.value]));
  let path = route.template;
  for (const placeholder of templatePlaceholders(route.template)) {
    const value = supplied.get(placeholder);
    if (value === undefined) {
      return { ok: false, error: `route ${route.id} needs the param ${placeholder}` };
    }
    path = path.replaceAll(`{${placeholder}}`, encodeURIComponent(value));
  }
  return { ok: true, value: path };
}

function findTarget(
  digest: PageDigest,
  target: { role: string; name: string },
): { id: string } | null {
  const node = digest.nodes.find(
    (candidate) => candidate.role === target.role && candidate.name.trim() === target.name,
  );
  return node === undefined ? null : { id: node.id };
}

function resolveValue(
  value: { from: "param"; name: string } | { from: "literal"; value: string },
  params: readonly AdapterParamValue[],
): Resolved<string> {
  if (value.from === "literal") return { ok: true, value: value.value };
  const supplied = params.find((param) => param.name === value.name);
  if (supplied === undefined) {
    return { ok: false, error: `the param ${value.name} was not supplied` };
  }
  return { ok: true, value: supplied.value };
}

export function resolveStepAction(
  step: AdapterStep,
  params: readonly AdapterParamValue[],
  digest: PageDigest,
): Resolved<AgentAction> {
  if (step.action === "navigate") {
    return { ok: true, value: { kind: "navigate", path: step.route } };
  }
  if (step.action === "waitFor") {
    return {
      ok: true,
      value: {
        kind: "waitFor",
        predicate: step.predicate,
        timeoutMs: step.timeoutMs ?? 15_000,
      },
    };
  }
  const target = findTarget(digest, step.target);
  if (target === null) {
    return {
      ok: false,
      error: `no ${step.target.role} named "${step.target.name}" is on the current page`,
    };
  }
  switch (step.action) {
    case "click":
      return { ok: true, value: { kind: "click", target } };
    case "type": {
      const value = resolveValue(step.value, params);
      if (!value.ok) return value;
      return { ok: true, value: { kind: "type", target, value: value.value } };
    }
    case "select": {
      const value = resolveValue(step.value, params);
      if (!value.ok) return value;
      return { ok: true, value: { kind: "select", target, optionLabel: value.value } };
    }
    case "check":
      return { ok: true, value: { kind: "check", target, checked: step.checked } };
    default: {
      const exhausted: never = step;
      throw new Error(`unreachable step ${JSON.stringify(exhausted)}`);
    }
  }
}
