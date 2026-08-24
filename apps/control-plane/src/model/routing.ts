export const PLANNING_MODEL = "claude-opus-5";
export const CLASSIFICATION_MODEL = "claude-haiku-4-5";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  model: string;
  effort: EffortLevel;
}

export const MODEL_ROUTING = {
  // Effort escalates on failure rather than upfront, so intelligence is paid for only where
  // the task proved hard.
  planning: { model: PLANNING_MODEL, effort: "high" } as ModelChoice,
  recovery: { model: PLANNING_MODEL, effort: "xhigh" } as ModelChoice,
  expectAdjudication: { model: PLANNING_MODEL, effort: "medium" } as ModelChoice,
  injectionClassification: { model: CLASSIFICATION_MODEL, effort: "low" } as ModelChoice,
  procedureShortlist: { model: CLASSIFICATION_MODEL, effort: "low" } as ModelChoice,
} as const;

export function planningChoice(previousStepFailed: boolean): ModelChoice {
  return previousStepFailed ? MODEL_ROUTING.recovery : MODEL_ROUTING.planning;
}
