import type { TaskResult } from "./runner.js";

export interface SuiteSummary {
  variant: "a" | "b";
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  threshold: number;
  meetsThreshold: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  wallClockMs: number;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

export function renderTable(results: readonly TaskResult[]): string {
  const header = [
    pad("task", 30),
    pad("result", 7),
    pad("ladder", 7),
    pad("steps", 6),
    pad("in", 7),
    pad("out", 6),
    pad("cache", 7),
    pad("ms", 6),
    "detail",
  ].join(" ");

  const rows = results.map((result) =>
    [
      pad(result.id, 30),
      pad(result.passed ? "pass" : "FAIL", 7),
      pad(result.ladderReached ?? "-", 7),
      pad(String(result.steps), 6),
      pad(String(result.inputTokens), 7),
      pad(String(result.outputTokens), 6),
      pad(String(result.cacheReadTokens), 7),
      pad(String(result.latencyMs), 6),
      result.failureDetail ?? "",
    ].join(" "),
  );

  return [header, "-".repeat(header.length), ...rows].join("\n");
}

export function summarise(
  variant: "a" | "b",
  results: readonly TaskResult[],
  threshold: number,
  wallClockMs: number,
): SuiteSummary {
  const passed = results.filter((result) => result.passed).length;
  const passRate = results.length === 0 ? 0 : passed / results.length;

  return {
    variant,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate,
    threshold,
    meetsThreshold: passRate >= threshold,
    inputTokens: results.reduce((total, result) => total + result.inputTokens, 0),
    outputTokens: results.reduce((total, result) => total + result.outputTokens, 0),
    cacheReadTokens: results.reduce((total, result) => total + result.cacheReadTokens, 0),
    wallClockMs,
  };
}

export function renderSummary(summary: SuiteSummary): string {
  return [
    "",
    `variant ${summary.variant}: ${String(summary.passed)}/${String(summary.total)} passed ` +
      `(${(summary.passRate * 100).toFixed(1)}%, threshold ${(summary.threshold * 100).toFixed(0)}%)`,
    `tokens in ${String(summary.inputTokens)}, out ${String(summary.outputTokens)}, ` +
      `cache read ${String(summary.cacheReadTokens)}`,
    `wall clock ${String(summary.wallClockMs)}ms`,
    summary.meetsThreshold ? "threshold met" : "THRESHOLD NOT MET",
  ].join("\n");
}
