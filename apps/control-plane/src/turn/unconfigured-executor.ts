import type { TurnExecutionOutcome } from "./runner.js";

export function unconfiguredPlannerExecutor(): Promise<TurnExecutionOutcome> {
  return Promise.resolve({
    resolutionState: "escalated",
    summary:
      "No planner is configured for this deployment, so nothing was attempted. " +
      "A person has been given this request.",
    closeConversation: true,
  });
}
