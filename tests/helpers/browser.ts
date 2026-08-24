import type { ExecutorAction, ToolResultPayload } from "@superguide/contract/public";
import type { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import type { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";

export type BrowserHandler = (action: ExecutorAction) => ToolResultPayload;

export interface SimulatedBrowser {
  dispatched: ExecutorAction[];
  stop: () => void;
}

// Stands in for the widget on the other end of the tool-result endpoint, so the server side
// of levels two, three, and four can be exercised without a browser.
export function simulateBrowser(
  ephemeral: EphemeralBus,
  pendingCalls: PendingCalls,
  conversationId: string,
  handler: BrowserHandler,
): SimulatedBrowser {
  const dispatched: ExecutorAction[] = [];

  const stop = ephemeral.subscribe(conversationId, (event) => {
    if (event.event !== "action.executing") return;
    dispatched.push(event.action);
    const payload = handler(event.action);
    setTimeout(() => {
      pendingCalls.deliver(conversationId, event.action.toolCallId, payload);
    }, 0);
  });

  return { dispatched, stop };
}
