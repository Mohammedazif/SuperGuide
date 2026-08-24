import type { ExpectPredicate } from "@superguide/contract/public";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface TemplateScope {
  params: Record<string, unknown>;
  identity: Record<string, unknown>;
}

function lookup(scope: TemplateScope, path: string): unknown {
  const segments = path.split(".");
  const root = segments[0];
  let current: unknown =
    root === "params" ? scope.params : root === "identity" ? scope.identity : undefined;

  for (const segment of segments.slice(1)) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveTemplateString(input: string, scope: TemplateScope): string {
  return input.replace(PLACEHOLDER, (match, path: string) => {
    const value = lookup(scope, path);
    if (value === undefined || value === null) return match;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolveUnknown(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") {
    const exact = PLACEHOLDER.exec(value);
    PLACEHOLDER.lastIndex = 0;
    if (exact !== null && exact[0] === value && exact[1] !== undefined) {
      const resolved = lookup(scope, exact[1]);
      return resolved === undefined ? value : resolved;
    }
    return resolveTemplateString(value, scope);
  }
  if (Array.isArray(value)) return value.map((item) => resolveUnknown(item, scope));
  return value;
}

export function resolveExpectTemplate(
  template: readonly ExpectPredicate[],
  scope: TemplateScope,
): ExpectPredicate[] {
  return template.map((predicate) => {
    switch (predicate.kind) {
      case "http_status":
        return predicate;
      case "json_path":
        return {
          ...predicate,
          path: resolveTemplateString(predicate.path, scope),
          ...(predicate.equals === undefined
            ? {}
            : { equals: resolveUnknown(predicate.equals, scope) }),
        };
      case "url_matches":
        return { ...predicate, pattern: resolveTemplateString(predicate.pattern, scope) };
      case "capability_status":
        return predicate;
      case "element_state":
        return {
          ...predicate,
          role: resolveTemplateString(predicate.role, scope),
          nameContains: resolveTemplateString(predicate.nameContains, scope),
        };
      default: {
        const exhaustive: never = predicate;
        throw new Error(`unhandled predicate: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
}
