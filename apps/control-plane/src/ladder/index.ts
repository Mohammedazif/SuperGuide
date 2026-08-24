import type { AgentAction } from "@superguide/contract/public";
import type { EphemeralBus } from "../events/ephemeral.js";
import type { PendingCalls } from "../turn/pending-calls.js";
import type { RequestSigner } from "../secrets/credentials.js";
import { executeApiCall } from "./api-executor.js";
import { executeInBrowser } from "./browser-executor.js";
import { failedResult, type ExecutionContext, type ExecutionResult, type Ladder } from "./types.js";

export interface LadderOptions {
  apiBaseUrl: string | null;
  signer: RequestSigner;
  ephemeral: EphemeralBus;
  pendingCalls: PendingCalls;
  groundedActionsEnabled: boolean;
  fetchImplementation?: typeof fetch;
}

export function createLadder(options: LadderOptions): Ladder {
  return {
    async execute(action: AgentAction, context: ExecutionContext): Promise<ExecutionResult> {
      switch (action.type) {
        case "call_api": {
          if (options.apiBaseUrl === null) {
            return failedResult("no_api_configured", "this product has no API base url configured");
          }
          return executeApiCall(action, context, {
            baseUrl: options.apiBaseUrl,
            signer: options.signer,
            ...(options.fetchImplementation === undefined
              ? {}
              : { fetchImplementation: options.fetchImplementation }),
          });
        }

        case "invoke_capability":
        case "navigate_route":
          return executeInBrowser(action, context, options);

        case "click":
        case "set_value":
        case "select_option":
        case "set_checked":
        case "press_key":
        case "scroll":
        case "hover":
        case "wait_for": {
          if (!options.groundedActionsEnabled) {
            return failedResult(
              "GROUNDED_ACTIONS_DISABLED",
              "operating the interface directly is switched off for this product",
            );
          }
          return executeInBrowser(action, context, options);
        }

        case "ask_user":
        case "escalate":
          return failedResult(
            "handled_by_the_loop",
            "asking and escalating are decided by the turn, not the ladder",
          );

        default: {
          const exhaustive: never = action;
          throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
}

export type { Ladder, ExecutionContext, ExecutionResult } from "./types.js";
