import { EXECUTOR_ACTION_TYPES, type ExecutorActionType } from "@superguide/contract/public";
import type { Product, ToolRecord } from "@superguide/contract/internal";
import { INTENT_PROPERTY, type CompiledTool, type JsonSchemaObject } from "./compiled.js";

const DEFAULT_API_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): JsonSchemaObject {
  return {
    type: "object",
    properties: { intent: INTENT_PROPERTY, ...properties },
    required: ["intent", ...required],
    additionalProperties: false,
  };
}

function apiTool(record: ToolRecord): CompiledTool | null {
  if (record.definition.kind !== "api") return null;
  const definition = record.definition;
  const parameters = definition.parameterSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  return {
    name: `api_${definition.operationId}`,
    description: definition.description,
    inputSchema: objectSchema(parameters.properties ?? {}, parameters.required ?? []),
    risk: record.riskClass,
    ladderLevel: "L1",
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    expectTemplate: record.expectTemplate,
    source: {
      kind: "api",
      operationId: definition.operationId,
      method: definition.method,
      path: definition.path,
      pathParams: definition.pathParams,
      queryParams: definition.queryParams,
      bodyParams: definition.bodyParams,
    },
  };
}

function capabilityTool(record: ToolRecord): CompiledTool | null {
  if (record.definition.kind !== "capability") return null;
  const definition = record.definition;
  const parameters = definition.parameterSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  return {
    name: `capability_${definition.capability}`,
    description: definition.description,
    inputSchema: objectSchema(parameters.properties ?? {}, parameters.required ?? []),
    risk: record.riskClass,
    ladderLevel: "L2",
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    expectTemplate:
      record.expectTemplate.length > 0
        ? record.expectTemplate
        : [{ kind: "capability_status", status: "ok" }],
    source: { kind: "capability", capability: definition.capability },
  };
}

function routeTools(product: Product): CompiledTool[] {
  return product.routeRegistry.routes.map((route) => {
    const properties: Record<string, unknown> = {};
    for (const parameter of route.params) {
      properties[parameter] = { type: "string", description: `Value for ${parameter}` };
    }
    return {
      name: `navigate_${route.id}`,
      description: `Take the person to ${route.title} at ${route.template}.`,
      inputSchema: objectSchema(properties, route.params),
      risk: "read" as const,
      ladderLevel: "L3" as const,
      timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
      expectTemplate: [
        { kind: "url_matches" as const, pattern: route.template.replace(/\{[^}]+\}/g, "[^/]+") },
      ],
      source: { kind: "route" as const, routeId: route.id, template: route.template },
    };
  });
}

const GROUNDED_SCHEMAS: Record<
  ExecutorActionType,
  { description: string; properties: Record<string, unknown>; required: string[] }
> = {
  click: {
    description: "Click one element that is present in the current page digest.",
    properties: { ref: { type: "string", description: "A ref from the page digest." } },
    required: ["ref"],
  },
  set_value: {
    description: "Replace the value of one text field from the page digest.",
    properties: {
      ref: { type: "string", description: "A ref from the page digest." },
      value: { type: "string" },
    },
    required: ["ref", "value"],
  },
  select_option: {
    description: "Choose one option in a select control.",
    properties: { ref: { type: "string" }, value: { type: "string" } },
    required: ["ref", "value"],
  },
  set_checked: {
    description: "Set a checkbox or switch to a state.",
    properties: { ref: { type: "string" }, checked: { type: "boolean" } },
    required: ["ref", "checked"],
  },
  press_key: {
    description: "Press one key, optionally focused on an element.",
    properties: { ref: { type: "string" }, key: { type: "string" } },
    required: ["key"],
  },
  scroll: {
    description: "Scroll the page or a scrollable element.",
    properties: {
      ref: { type: "string" },
      direction: { type: "string", enum: ["up", "down"] },
      amount: { type: "integer" },
    },
    required: ["direction"],
  },
  hover: {
    description: "Hover one element to reveal what it discloses.",
    properties: { ref: { type: "string" } },
    required: ["ref"],
  },
  wait_for: {
    description: "Wait until an element with a role and name appears.",
    properties: { role: { type: "string" }, nameContains: { type: "string" } },
    required: ["role", "nameContains"],
  },
  navigate_route: {
    description: "Reserved. Use a navigate_ tool instead.",
    properties: {},
    required: [],
  },
  invoke_capability: {
    description: "Reserved. Use a capability_ tool instead.",
    properties: {},
    required: [],
  },
};

function groundedTools(): CompiledTool[] {
  return EXECUTOR_ACTION_TYPES.filter(
    (type) => type !== "navigate_route" && type !== "invoke_capability",
  ).map((type) => {
    const schema = GROUNDED_SCHEMAS[type];
    return {
      name: `ui_${type}`,
      description: schema.description,
      inputSchema: objectSchema(schema.properties, schema.required),
      risk: type === "click" || type === "wait_for" || type === "scroll" || type === "hover"
        ? ("read" as const)
        : ("write" as const),
      ladderLevel: "L4" as const,
      timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
      expectTemplate: [{ kind: "capability_status" as const, status: "ok" as const }],
      source: { kind: "grounded" as const, actionType: type },
    };
  });
}

function controlTools(): CompiledTool[] {
  return [
    {
      name: "ask_user",
      description:
        "Ask the person exactly one question when a fact you need cannot be read from the product.",
      inputSchema: objectSchema(
        {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" }, maxItems: 6 },
        },
        ["question"],
      ),
      risk: "read",
      ladderLevel: "L5",
      timeoutMs: 300_000,
      expectTemplate: [{ kind: "capability_status", status: "ok" }],
      source: { kind: "ask_user" },
    },
    {
      name: "escalate",
      description:
        "Hand this to a person, with everything that was attempted. Use it when you cannot finish honestly.",
      inputSchema: objectSchema({ reason: { type: "string" }, summary: { type: "string" } }, [
        "reason",
        "summary",
      ]),
      risk: "read",
      ladderLevel: "L6",
      timeoutMs: 10_000,
      expectTemplate: [{ kind: "capability_status", status: "ok" }],
      source: { kind: "escalate" },
    },
    {
      name: "finish",
      description:
        "Say the task is done. Only call this after a check you ran confirmed the new state.",
      inputSchema: objectSchema(
        {
          summary: { type: "string" },
          resolutionState: { type: "string", enum: ["resolved", "unresolved"] },
        },
        ["summary", "resolutionState"],
      ),
      risk: "read",
      ladderLevel: "L6",
      timeoutMs: 10_000,
      expectTemplate: [{ kind: "capability_status", status: "ok" }],
      source: { kind: "finish" },
    },
  ];
}

export interface CompileToolsInput {
  product: Product;
  tools: readonly ToolRecord[];
  groundedActionsEnabled: boolean;
}

export function compileTools(input: CompileToolsInput): CompiledTool[] {
  const compiled: CompiledTool[] = [];

  for (const record of input.tools) {
    if (!record.enabled) continue;
    const api = apiTool(record);
    if (api !== null) {
      compiled.push(api);
      continue;
    }
    const capability = capabilityTool(record);
    if (capability !== null) compiled.push(capability);
  }

  compiled.push(...routeTools(input.product));
  if (input.groundedActionsEnabled) compiled.push(...groundedTools());
  compiled.push(...controlTools());

  // Sorted so the cached prefix is byte-identical across turns of the same conversation.
  return compiled.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
