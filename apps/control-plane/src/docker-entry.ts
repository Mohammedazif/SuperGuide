import { bootstrapHostedRoles } from "./db/bootstrap.js";
import { explainPgConnectError } from "./db/connect.js";
import { runMigrations } from "./db/migrate.js";
import { loadMigrationConnectionString, shouldBootstrapRoles } from "./env.js";

try {
  if (shouldBootstrapRoles()) {
    await bootstrapHostedRoles();
    process.stdout.write("hosted roles ready\n");
  }
  const outcome = await runMigrations(loadMigrationConnectionString());
  process.stdout.write(
    `migrations: applied ${String(outcome.applied.length)}, skipped ${String(outcome.skipped.length)}\n`,
  );
  for (const name of outcome.applied) process.stdout.write(`  + ${name}\n`);
} catch (error) {
  process.stderr.write(`${explainPgConnectError(error)}\n`);
  process.exit(1);
}

await import("./main.js");
