type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function sortValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = sortValue(entry);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(JSON.parse(JSON.stringify(value)) as Json));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function paramsHashOf(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}
