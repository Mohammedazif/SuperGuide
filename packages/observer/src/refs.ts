// Strip framework-generated ids so a minted ref survives a re-render.
const VOLATILE_ID = /^(:r[0-9a-z]+:|react-aria-\d+|mui-\d+|headlessui-[\w-]+|radix-[\w-]+|v-[0-9a-f]{6,}|ember\d+|ng-\w+-\d+)$/i;
const VOLATILE_FRAGMENT = /[0-9a-f]{8,}/i;

export function stableIdentifier(value: string | null): string {
  if (value === null || value.length === 0) return "";
  if (VOLATILE_ID.test(value)) return "";
  if (VOLATILE_FRAGMENT.test(value)) return "";
  return value;
}

export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function mintRef(signature: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = `e${String(fnv1a(attempt === 0 ? signature : `${signature}#${String(attempt)}`))}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not mint a unique ref");
}
