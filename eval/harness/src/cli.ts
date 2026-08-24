import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { evalTaskSchema, type EvalTask } from "./task.js";
import { createHarness, type TaskResult } from "./runner.js";
import { renderSummary, renderTable, summarise } from "./report.js";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TASKS_DIR = join(HARNESS_ROOT, "tasks");
const RESULTS_DIR = join(HARNESS_ROOT, "results");

const DEFAULT_THRESHOLD = 1;

function loadTasks(): EvalTask[] {
  const files = readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort();

  const tasks: EvalTask[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const raw: unknown = parseYaml(readFileSync(join(TASKS_DIR, file), "utf8"));
    const parsed = evalTaskSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(
        `${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join(", ")}`,
      );
      continue;
    }
    tasks.push(parsed.data);
  }

  if (problems.length > 0) {
    console.error("These task fixtures could not be read:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  return tasks;
}

function argument(name: string, fallback: string): string {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
}

async function main(): Promise<void> {
  const variant = argument("variant", "a") === "b" ? "b" : "a";
  const threshold = Number(argument("threshold", String(DEFAULT_THRESHOLD)));
  const only = argument("only", "");

  const databaseUrl = process.env["SG_DATABASE_URL"];
  const migrationUrl = process.env["SG_MIGRATION_DATABASE_URL"] ?? databaseUrl;
  if (databaseUrl === undefined || migrationUrl === undefined) {
    console.error("SG_DATABASE_URL and SG_MIGRATION_DATABASE_URL must be set");
    process.exit(1);
  }

  const tasks = loadTasks().filter((task) => only === "" || task.id === only);
  if (tasks.length === 0) {
    console.error("no tasks matched");
    process.exit(1);
  }

  console.log(`running ${String(tasks.length)} tasks against interface variant ${variant}`);

  const harness = await createHarness({ variant, databaseUrl, migrationUrl });
  const startedAt = Date.now();
  const results: TaskResult[] = [];

  try {
    for (const task of tasks) {
      const result = await harness.run(task);
      results.push(result);
      console.log(`  ${result.passed ? "pass" : "FAIL"}  ${task.id}`);
    }
  } finally {
    await harness.close();
  }

  // The deterministic layers must be exactly reproducible: policy verdicts, expect evaluation,
  // procedure tie-breaks, and routing all run again and every field except wall-clock is compared.
  if (process.argv.includes("--check-determinism")) {
    const second = await createHarness({ variant, databaseUrl, migrationUrl });
    const repeated: TaskResult[] = [];
    try {
      for (const task of tasks) repeated.push(await second.run(task));
    } finally {
      await second.close();
    }

    const drop = (result: TaskResult): string =>
      JSON.stringify({ ...result, latencyMs: 0 });
    const drifted = results
      .map((result, index) => ({ result, other: repeated[index] }))
      .filter((pair) => pair.other === undefined || drop(pair.result) !== drop(pair.other));

    if (drifted.length > 0) {
      console.error("\nthese tasks did not reproduce exactly:");
      for (const pair of drifted) console.error(`  ${pair.result.id}`);
      process.exit(1);
    }
    console.log(`\nall ${String(results.length)} tasks reproduced exactly on a second run`);
  }

  const summary = summarise(variant, results, threshold, Date.now() - startedAt);

  console.log("");
  console.log(renderTable(results));
  console.log(renderSummary(summary));

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `variant-${variant}.json`),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );

  if (!summary.meetsThreshold) process.exit(1);
}

await main();
