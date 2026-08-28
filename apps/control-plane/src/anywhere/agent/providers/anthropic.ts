import Anthropic from "@anthropic-ai/sdk";
import { scanForInjection } from "../classifier.js";
import type { ModelProvider } from "../provider.js";

export function makeAnthropicProvider(apiKey: string): ModelProvider {
  const client = new Anthropic({ apiKey });
  return {
    plan: (request) => client.beta.messages.stream(request).finalMessage(),
    scan: (strings) => scanForInjection(client, strings),
  };
}
