import { runMigrations } from "../../apps/control-plane/src/db/migrate.js";

export default async function setup(): Promise<void> {
  const url = process.env["SG_MIGRATION_DATABASE_URL"];
  if (url === undefined) {
    throw new Error("SG_MIGRATION_DATABASE_URL must be set for database-backed tests");
  }
  await runMigrations(url);
}
