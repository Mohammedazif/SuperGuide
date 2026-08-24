import { CONTRACT_PUBLIC_MARKER } from "@superguide/contract/public";
import { boot, readConfiguration, type QueuedCall } from "./boot.js";

interface QueuedGlobal {
  (...args: unknown[]): void;
  q?: unknown[][];
}

// Any failure here leaves the host page exactly as it was, and says so once.
function start(): void {
  const configuration = readConfiguration(document);
  if (configuration === null) return;

  const booted = boot({ document, window: globalThis as Window & typeof globalThis }, configuration);

  const existing = (globalThis as { superguide?: QueuedGlobal }).superguide;
  const queued = existing?.q ?? [];

  const api: QueuedGlobal = (...args: unknown[]) => {
    booted.handle(args as QueuedCall);
  };

  (globalThis as { superguide?: QueuedGlobal }).superguide = api;

  for (const call of queued) booted.handle(call as QueuedCall);

  document.dispatchEvent(
    new CustomEvent("sg:ready", {
      detail: { productId: configuration.productId, contract: CONTRACT_PUBLIC_MARKER },
    }),
  );
}

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      try {
        start();
      } catch (error) {
        document.dispatchEvent(new CustomEvent("sg:boot-failed", { detail: String(error) }));
      }
    });
  } else {
    start();
  }
} catch (error) {
  document.dispatchEvent(new CustomEvent("sg:boot-failed", { detail: String(error) }));
}
