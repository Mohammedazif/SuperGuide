import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadBootstrapConnectionStrings } from "../env.js";

const APP_ROLE = "sg_app";
const MIGRATOR_ROLE = "sg_migrator";

export function parsePostgresUrl(connectionString: string): {
  user: string;
  password: string;
  database: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(connectionString.replace(/^postgres(?:ql)?:/i, "http:"));
  } catch {
    throw new Error("database URL is not a valid postgres URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")).split("/")[0] ?? "";
  if (database.length === 0) throw new Error("postgres URL must include a database name");
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ensureRoleSql(role: string, password: string): string {
  return `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)};
  END IF;
END
$$;
ALTER ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)};
`.trim();
}

export async function bootstrapHostedRoles(): Promise<void> {
  const { app: appUrl, migration: migrationUrl } = loadBootstrapConnectionStrings();

  const app = parsePostgresUrl(appUrl);
  const migrator = parsePostgresUrl(migrationUrl);
  if (app.user !== APP_ROLE) {
    throw new Error(`SG_DATABASE_URL user must be ${APP_ROLE}; migrations grant to that role`);
  }

  const migratorPassword =
    migrator.user === MIGRATOR_ROLE ? migrator.password : randomBytes(32).toString("base64");

  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const dbName = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0]
      ?.db;
    if (dbName === undefined || dbName.length === 0) {
      throw new Error("could not read current_database()");
    }

    await client.query(ensureRoleSql(APP_ROLE, app.password));
    await client.query(ensureRoleSql(MIGRATOR_ROLE, migratorPassword));
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(APP_ROLE)}`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(MIGRATOR_ROLE)}`,
    );
    try {
      await client.query(
        `GRANT CREATE ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(MIGRATOR_ROLE)}`,
      );
    } catch {
      process.stdout.write(
        "skipped GRANT CREATE ON DATABASE; migrate as the platform postgres role\n",
      );
    }
    await client.query(
      `GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)}, ${quoteIdent(MIGRATOR_ROLE)}`,
    );
    try {
      await client.query(`GRANT CREATE ON SCHEMA public TO ${quoteIdent(MIGRATOR_ROLE)}`);
    } catch {
      process.stdout.write(
        "skipped GRANT CREATE ON SCHEMA public; migrate as the platform postgres role\n",
      );
    }
  } finally {
    await client.end();
  }
}
