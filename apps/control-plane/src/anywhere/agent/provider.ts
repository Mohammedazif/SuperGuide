import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { Environment } from "../../env.js";
import type { InjectionScan } from "./classifier.js";
import { makeAnthropicProvider } from "./providers/anthropic.js";
import { makeGeminiProvider } from "./providers/gemini.js";
import { makeOpenAIProvider } from "./providers/openai.js";

// Anthropic message shape is the loop's wire format for every vendor.
export interface ModelProvider {
  plan(request: BetaMessageStreamParams): Promise<Anthropic.Beta.Messages.BetaMessage>;
  scan(strings: string[]): Promise<InjectionScan>;
}

export type ProviderName = Environment["SG_MODEL_PROVIDER"];

export function providerKeyOf(env: Environment): string {
  switch (env.SG_MODEL_PROVIDER) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY;
  }
}

export function makeProvider(env: Environment): ModelProvider {
  switch (env.SG_MODEL_PROVIDER) {
    case "anthropic":
      return makeAnthropicProvider(env.ANTHROPIC_API_KEY);
    case "openai":
      return makeOpenAIProvider(env.OPENAI_API_KEY);
    case "gemini":
      return makeGeminiProvider(env.GEMINI_API_KEY);
  }
}
