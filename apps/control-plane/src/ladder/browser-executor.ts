import {
  ladderLevelForActionType,
  type AgentAction,
  type ExecutorAction,
} from "@superguide/contract/public";
import type { EphemeralBus } from "../events/ephemeral.js";
import type { PendingCalls } from "../turn/pending-calls.js";
import { failedResult, type ExecutionContext, type ExecutionResult } from "./types.js";

export interface BrowserExecutorOptions {
  ephemeral: EphemeralBus;
  pendingCalls: PendingCalls;
}

export function toExecutorAction(action: AgentAction): ExecutorAction | null {
  if (action.type === "call_api" || action.type === "ask_user" || action.type === "escalate") {
    return null;
  }
  return action;
}

export async function executeInBrowser(
  action: AgentAction,
  context: ExecutionContext,
  options: BrowserExecutorOptions,
): Promise<ExecutionResult> {
  const executorAction = toExecutorAction(action);
  if (executorAction === null) {
    return failedResult("not_a_browser_action", "this action does not run in the browser");
  }

  const announcement = {
    turnId: context.turnId,
    action: executorAction,
    ladderLevel: ladderLevelForActionType(action.type),
  };

  const settled = options.pendingCalls.register(
    action.toolCallId,
    context.conversationId,
    action.timeoutMs,
    () => ({
      status: "failed",
      error: { code: "TIMEOUT", message: "the browser did not report a result in time" },
      digest: null,
      url: "",
    }),
    announcement,
  );

  options.ephemeral.publish(context.conversationId, {
    event: "action.executing",
    ...announcement,
  });

  const payload = await settled;

  if (payload.status === "ok") {
    return {
      status: "ok",
      data: payload.data,
      httpStatus: null,
      url: payload.url.length === 0 ? null : payload.url,
      capabilityStatus: "ok",
      digest: payload.digest,
      code: null,
      message: null,
    };
  }

  return {
    status: "failed",
    data: null,
    httpStatus: null,
    url: payload.url.length === 0 ? null : payload.url,
    capabilityStatus: "failed",
    digest: payload.digest,
    code: payload.error.code,
    message: payload.error.message,
  };
}
