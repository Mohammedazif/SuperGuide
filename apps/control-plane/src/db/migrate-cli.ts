import { loadMigrationConnectionString } from "../env.js";
import { runMigrations } from "./migrate.js";

try {
  const outcome = await runMigrations(loadMigrationConnectionString());
  process.stdout.write(
    `applied ${outcome.applied.length}, already present ${outcome.skipped.length}\n`,
  );
  for (const name of outcome.applied) process.stdout.write(`  + ${name}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
