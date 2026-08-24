import type { AgentAction, PageDigest } from "@superguide/contract/public";
import type { CompiledTool } from "../tools/compiled.js";

export interface ExecutionResult {
  status: "ok" | "failed";
  data: unknown;
  httpStatus: number | null;
  url: string | null;
  capabilityStatus: "ok" | "failed" | null;
  digest: PageDigest | null;
  code: string | null;
  message: string | null;
}

export interface ExecutionContext {
  productId: string;
  conversationId: string;
  turnId: string;
  tool: CompiledTool;
  signal: AbortSignal;
}

export interface Ladder {
  execute(action: AgentAction, context: ExecutionContext): Promise<ExecutionResult>;
}

export function failedResult(code: string, message: string): ExecutionResult {
  return {
    status: "failed",
    data: null,
    httpStatus: null,
    url: null,
    capabilityStatus: "failed",
    digest: null,
    code,
    message,
  };
}
