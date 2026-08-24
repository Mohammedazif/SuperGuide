import type { CapabilityDescriptor, RiskClass } from "@superguide/contract/public";
import type { CapabilityRegistry, RegisteredCapability } from "@superguide/executor";

export interface CapabilityDefinition {
  name: string;
  description: string;
  risk: RiskClass;
  parameters: Record<string, unknown>;
  parse?: (input: unknown) => { success: true; data: unknown } | { success: false; message: string };
  handler: (argument: unknown) => Promise<{ status: "ok" | "failed"; data?: unknown; message?: string }> | { status: "ok" | "failed"; data?: unknown; message?: string };
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ClientCapabilityRegistry implements CapabilityRegistry {
  readonly #entries = new Map<string, RegisteredCapability>();
  readonly #descriptors = new Map<string, CapabilityDescriptor>();

  register(definitions: readonly CapabilityDefinition[]): {
    accepted: string[];
    rejected: { name: string; reason: string }[];
  } {
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];

    for (const definition of definitions) {
      if (!NAME.test(definition.name)) {
        rejected.push({ name: definition.name, reason: "the name is not a safe identifier" });
        continue;
      }
      if (typeof definition.handler !== "function") {
        rejected.push({ name: definition.name, reason: "no handler was supplied" });
        continue;
      }

      const parse =
        definition.parse ??
        ((input: unknown) =>
          typeof input === "object" && input !== null
            ? ({ success: true, data: input } as const)
            : ({ success: false, message: "arguments must be an object" } as const));

      this.#entries.set(definition.name, {
        name: definition.name,
        risk: definition.risk,
        parse,
        handler: definition.handler,
      });

      this.#descriptors.set(definition.name, {
        name: definition.name,
        description: definition.description,
        // The risk class comes from the customer's registration and is never inferred here.
        risk: definition.risk,
        parameters: definition.parameters,
      });

      accepted.push(definition.name);
    }

    return { accepted, rejected };
  }

  get(name: string): RegisteredCapability | null {
    return this.#entries.get(name) ?? null;
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  descriptors(): CapabilityDescriptor[] {
    return [...this.#descriptors.values()];
  }
}
