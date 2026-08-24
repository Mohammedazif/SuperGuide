import type {
  ExecutorActionType,
  ExpectPredicate,
  LadderLevel,
  RiskClass,
} from "@superguide/contract/public";
import type { HttpMethod } from "@superguide/contract/internal";

export type CompiledToolSource =
  | {
      kind: "api";
      operationId: string;
      method: HttpMethod;
      path: string;
      pathParams: string[];
      queryParams: string[];
      bodyParams: string[];
    }
  | { kind: "capability"; capability: string }
  | { kind: "route"; routeId: string; template: string }
  | { kind: "grounded"; actionType: ExecutorActionType }
  | { kind: "ask_user" }
  | { kind: "escalate" }
  | { kind: "finish" };

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface CompiledTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  risk: RiskClass;
  ladderLevel: LadderLevel;
  timeoutMs: number;
  expectTemplate: ExpectPredicate[];
  source: CompiledToolSource;
}

export const INTENT_PROPERTY = {
  type: "string",
  description:
    "One sentence in plain language saying what this step is for, written for the person you are helping.",
} as const;
