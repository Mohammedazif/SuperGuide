import type Anthropic from "@anthropic-ai/sdk";
import { MODEL_ROUTING } from "../../model/routing.js";
import type { ModelClient } from "../../model/client.js";
import { CLASSIFIER_SYSTEM, classifierUserContent, injectionScanSchema, type InjectionScan } from "./classifier.js";
import { AGENT_TOOLS, plannerSystem } from "./prompts.js";

export function anywherePlan(
  client: ModelClient,
): (messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message> {
  return async (messages) => {
    const result = await client.generate({
      model: MODEL_ROUTING.planning.model,
      effort: MODEL_ROUTING.planning.effort,
      system: plannerSystem(),
      tools: AGENT_TOOLS,
      messages,
      signal: new AbortController().signal,
    });
    return result.message;
  };
}

export function anywhereScan(client: ModelClient): (strings: string[]) => Promise<InjectionScan> {
  return async (strings) => {
    if (strings.length === 0) return { suspicious: false, findings: [] };
    return client.classify({
      model: MODEL_ROUTING.injectionClassification.model,
      effort: MODEL_ROUTING.injectionClassification.effort,
      system: CLASSIFIER_SYSTEM,
      prompt: classifierUserContent(strings),
      schema: injectionScanSchema,
      signal: new AbortController().signal,
    });
  };
}
