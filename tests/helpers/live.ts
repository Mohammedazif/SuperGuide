const PLACEHOLDER = /^(sg-local|test-key)/;

export function liveApiKey(): string | null {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) return null;
  if (PLACEHOLDER.test(key)) return null;
  return key;
}

export const LIVE_MODEL_REASON =
  "ANTHROPIC_API_KEY is not set to a real key, so no live model call was made";
