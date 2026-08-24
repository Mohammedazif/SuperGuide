const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "if", "in", "is",
  "it", "of", "on", "or", "the", "to", "with", "when",
]);

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

// A rule matches when every meaningful token in it appears in the subject. Deterministic,
// order independent, and evaluated outside the model.
export function ruleMatches(rule: string, subject: string): boolean {
  const needles = tokenise(rule);
  if (needles.length === 0) return false;
  const haystack = new Set(tokenise(subject));
  return needles.every((needle) => haystack.has(needle));
}

export function firstMatchingRule(
  rules: readonly string[],
  subjects: readonly string[],
): string | null {
  for (const rule of rules) {
    for (const subject of subjects) {
      if (ruleMatches(rule, subject)) return rule;
    }
  }
  return null;
}
