export type OriginDecision = { allowed: true; origin: string } | { allowed: false };

export function checkOrigin(
  headerValue: string | undefined,
  allowlist: readonly string[],
): OriginDecision {
  if (headerValue === undefined || headerValue.length === 0) return { allowed: false };

  let normalised: string;
  try {
    const parsed = new URL(headerValue);
    normalised = parsed.origin;
  } catch {
    return { allowed: false };
  }

  for (const entry of allowlist) {
    let candidate: string;
    try {
      candidate = new URL(entry).origin;
    } catch {
      continue;
    }
    if (candidate === normalised) return { allowed: true, origin: normalised };
  }
  return { allowed: false };
}
