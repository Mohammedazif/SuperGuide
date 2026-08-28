import type { SettleOptions } from "./types.js";

const WATCHED_ATTRIBUTES = [
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "data-state",
  "open",
  "checked",
];

export const DEFAULT_SETTLE: SettleOptions = { quietPeriodMs: 120, ceilingMs: 3000 };

// Quiet period after mutations; ceiling so a never-settling page cannot hold a turn open.
export function waitForSettle(
  document: Document,
  options: SettleOptions = DEFAULT_SETTLE,
): Promise<"quiet" | "ceiling"> {
  return new Promise((resolve) => {
    const view = document.defaultView;
    if (view === null) {
      resolve("quiet");
      return;
    }

    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (reason: "quiet" | "ceiling"): void => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      observer.disconnect();
      resolve(reason);
    };

    const restartQuietPeriod = (): void => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        finish("quiet");
      }, options.quietPeriodMs);
    };

    const observer = new view.MutationObserver(() => {
      restartQuietPeriod();
    });

    const ceilingTimer = setTimeout(() => {
      finish("ceiling");
    }, options.ceilingMs);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });

    restartQuietPeriod();
  });
}
