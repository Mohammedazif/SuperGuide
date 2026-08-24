import type { ClientErrorCode, ExecutorAction, PageDigest } from "@superguide/contract/public";

export type ExecutionOutcome =
  | { status: "ok"; data: unknown; digest: PageDigest | null; url: string }
  | {
      status: "failed";
      error: { code: ClientErrorCode; message: string };
      digest: PageDigest | null;
      url: string;
    };

export interface ConfirmationRequest {
  toolCallId: string;
  paramsHash: string;
  preview: string;
  action: ExecutorAction;
}

// One call, one action. There is no method here through which an approval could be cached,
// and this package holds no module-level state that could become one.
export interface Confirmer {
  request(request: ConfirmationRequest): Promise<"approved" | "denied" | "timeout">;
}

export interface CapabilityHandlerResult {
  status: "ok" | "failed";
  data?: unknown;
  message?: string;
}

export interface RegisteredCapability {
  name: string;
  risk: string;
  parse(input: unknown): { success: true; data: unknown } | { success: false; message: string };
  handler(argument: unknown): Promise<CapabilityHandlerResult> | CapabilityHandlerResult;
}

export interface CapabilityRegistry {
  get(name: string): RegisteredCapability | null;
  names(): string[];
}

export interface Navigator {
  navigate(url: string): Promise<void> | void;
  currentUrl(): string;
}

export interface SettleOptions {
  quietPeriodMs: number;
  ceilingMs: number;
}
