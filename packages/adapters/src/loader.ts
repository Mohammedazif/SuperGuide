import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { siteAdapterSchema, type AdapterSet, type SiteAdapter } from "@superguide/contract/anywhere";

export class AdapterParseError extends Error {
  constructor(
    readonly source: string,
    detail: string,
  ) {
    super(`adapter ${source} is invalid: ${detail}`);
    this.name = "AdapterParseError";
  }
}

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/g;

export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

export function parseAdapter(source: string, text: string): SiteAdapter {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (cause) {
    throw new AdapterParseError(source, cause instanceof Error ? cause.message : String(cause));
  }
  const parsed = siteAdapterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterParseError(source, parsed.error.message);
  }
  const adapter = parsed.data;

  for (const route of adapter.routes) {
    const declared = new Set(route.params);
    for (const placeholder of templatePlaceholders(route.template)) {
      if (!declared.has(placeholder)) {
        throw new AdapterParseError(
          source,
          `route ${route.id} references undeclared param {${placeholder}}`,
        );
      }
    }
  }
  for (const capability of adapter.capabilities) {
    const declared = new Set(capability.params.map((param) => param.name));
    for (const step of capability.steps) {
      const value = "value" in step ? step.value : null;
      if (value !== null && value.from === "param" && !declared.has(value.name)) {
        throw new AdapterParseError(
          source,
          `capability ${capability.id} references undeclared param ${value.name}`,
        );
      }
    }
  }
  return adapter;
}

export function loadAdapterDirectory(directory: string): AdapterSet {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const adapters: SiteAdapter[] = files.map((name) =>
    parseAdapter(name, readFileSync(join(directory, name), "utf8")),
  );
  const version = adapters.reduce((highest, adapter) => Math.max(highest, adapter.version), 1);
  return { version, adapters };
}
