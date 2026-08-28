const PLACEHOLDER = /^(sg-local|test-key)/;

export type LiveProviderName = "anthropic" | "openai" | "gemini";

export interface LiveProvider {
  provider: LiveProviderName;
  keyName: string;
  key: string | null;
}

// Gate on the .env-selected provider's key, not always Anthropic.
export function liveProvider(): LiveProvider {
  const raw = process.env["SG_MODEL_PROVIDER"];
  const provider: LiveProviderName = raw === "openai" || raw === "gemini" ? raw : "anthropic";
  const keyName =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "gemini"
        ? "GEMINI_API_KEY"
        : "ANTHROPIC_API_KEY";
  const key = process.env[keyName];
  if (key === undefined || key.length === 0 || PLACEHOLDER.test(key)) {
    return { provider, keyName, key: null };
  }
  return { provider, keyName, key };
}

export function liveApiKey(): string | null {
  return liveProvider().key;
}

export const LIVE_MODEL_REASON = `${liveProvider().keyName} is not set to a real key, so no live model call was made`;
