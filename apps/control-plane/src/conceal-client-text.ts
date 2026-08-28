// Strings a person can read must never name a vendor, a model id, or an API.
// Planner instructions also forbid it; this is the belt if the model ignores that.

const MODEL_OR_VENDOR =
  /\b(?:open\s*ai|chatgpt|chat\s*gpt|anthropic|claude(?:[-\s][\w.]+)?|gemini(?:[-\s][\w.]+)?|google\s*ai(?:\s*studio)?|gpt-[\w.]+|o3(?:-mini)?)\b/gi;

export function namesModelOrVendor(text: string): boolean {
  MODEL_OR_VENDOR.lastIndex = 0;
  return MODEL_OR_VENDOR.test(text);
}

export function concealClientText(text: string, fallback: string): string {
  if (!namesModelOrVendor(text)) return text;
  const kept = text
    .split(/(?<=[.!?])(?:\s+|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !namesModelOrVendor(part));
  if (kept.length === 0) return fallback;
  return kept.join(" ");
}
