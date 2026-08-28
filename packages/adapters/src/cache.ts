import type { AdapterSet } from "@superguide/contract/anywhere";

export function pickAdapterSet(
  cached: AdapterSet | null,
  fetched: AdapterSet | null,
): AdapterSet | null {
  // The server's set always wins when it answered, even against a cached set
  // with a higher version: a cached adapter newer than the server's is
  // discarded, never preferred. The cache exists only to survive a failed fetch.
  return fetched ?? cached;
}
