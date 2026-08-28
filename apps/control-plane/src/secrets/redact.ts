export const REDACTED = "[redacted]";

const DENYLISTED_KEYS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|pwd|private[-_]?key|session|sessiontoken|credential|credentials|otp|pin|cvv|card[-_]?number|ssn)$/i;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;

export interface RedactionOptions {
  secretValues: readonly string[];
  allowedFieldNames: readonly string[];
  maxDepth?: number;
}

function scrubString(value: string, options: RedactionOptions): string {
  let output = value;
  for (const secret of options.secretValues) {
    if (secret.length < 6) continue;
    output = output.split(secret).join(REDACTED);
  }
  output = output.replace(BEARER, `Bearer ${REDACTED}`).replace(BASIC, `Basic ${REDACTED}`);
  return output;
}

// Everything written to the trajectory passes through this first.
export function redact(value: unknown, options: RedactionOptions, depth = 0): unknown {
  const maxDepth = options.maxDepth ?? 12;
  if (depth > maxDepth) return REDACTED;

  if (typeof value === "string") return scrubString(value, options);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => redact(item, options, depth + 1));

  if (typeof value === "object") {
    const allowed = new Set(options.allowedFieldNames.map((name) => name.toLowerCase()));
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (DENYLISTED_KEYS.test(key) && !allowed.has(key.toLowerCase())) {
        output[key] = REDACTED;
        continue;
      }
      output[key] = redact(entry, options, depth + 1);
    }
    return output;
  }

  return REDACTED;
}
