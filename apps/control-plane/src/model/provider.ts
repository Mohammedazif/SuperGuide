import type { Environment } from "../env.js";
import { AnthropicModelClient, type ModelClient } from "./client.js";
import { GeminiModelClient } from "./gemini-client.js";
import { OpenAIModelClient } from "./openai-client.js";

// The loop, prompt prefix, and journal all speak one wire shape — the
// Anthropic message shape — regardless of which vendor serves it. A client
// translates that shape at the edge; nothing downstream of generate()/classify()
// knows which provider answered.
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

export function makeModelClient(env: Environment): ModelClient {
  switch (env.SG_MODEL_PROVIDER) {
    case "anthropic":
      return new AnthropicModelClient({ apiKey: env.ANTHROPIC_API_KEY });
    case "openai":
      return new OpenAIModelClient({ apiKey: env.OPENAI_API_KEY });
    case "gemini":
      return new GeminiModelClient({ apiKey: env.GEMINI_API_KEY });
  }
}
