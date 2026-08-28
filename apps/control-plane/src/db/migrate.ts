import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConnectOptions } from "./connect.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function listMigrations(): { filename: string; contents: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      filename,
      contents: readFileSync(join(MIGRATIONS_DIR, filename), "utf8"),
    }));
}

export async function runMigrations(connectionString: string): Promise<MigrationOutcome> {
  const client = new pg.Client(pgConnectOptions(connectionString));
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    const migrations = listMigrations();
    const bootstrap = migrations[0];
    if (bootstrap === undefined) throw new Error("no migrations found");

    await client.query("BEGIN");
    await client.query(bootstrap.contents);
    const bootstrapInsert = await client.query(
      "INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING RETURNING filename",
      [bootstrap.filename, checksum(bootstrap.contents)],
    );
    await client.query("COMMIT");
    if (bootstrapInsert.rowCount === 1) applied.push(bootstrap.filename);
    else skipped.push(bootstrap.filename);

    for (const migration of migrations.slice(1)) {
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migration WHERE filename = $1",
        [migration.filename],
      );
      const previous = existing.rows[0];
      const current = checksum(migration.contents);

      if (previous !== undefined) {
        if (previous.checksum !== current) {
          throw new Error(
            `${migration.filename} was modified after being applied. Migrations are immutable.`,
          );
        }
        skipped.push(migration.filename);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.contents);
        await client.query("INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)", [
          migration.filename,
          current,
        ]);
        await client.query("COMMIT");
        applied.push(migration.filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}
