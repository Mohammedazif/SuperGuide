import type { AdapterSet } from "@superguide/contract/anywhere";

export function pickAdapterSet(
  cached: AdapterSet | null,
  fetched: AdapterSet | null,
): AdapterSet | null {
  // Fetched always wins, even vs a newer cache; cache is only a failed-fetch fallback.
  return fetched ?? cached;
}
