import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadBootstrapConnectionStrings } from "../env.js";
import { parsePostgresUrl, pgConnectOptions } from "./connect.js";

export { parsePostgresUrl } from "./connect.js";

const APP_ROLE = "sg_app";
const MIGRATOR_ROLE = "sg_migrator";

export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function postgresRoleName(user: string): string {
  const separator = user.indexOf(".");
  return separator > 0 ? user.slice(0, separator) : user;
}

export function createLoginRoleSql(role: string, password: string): string {
  return `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`;
}

export function alterLoginPasswordSql(role: string, password: string): string {
  return `ALTER ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`;
}

async function tryQuery(client: pg.Client, sql: string, skipLabel: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(`skipped ${skipLabel}: ${detail}\n`);
  }
}

async function ensureLoginRole(client: pg.Client, role: string, password: string): Promise<void> {
  const existing = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role],
  );
  if (existing.rows[0]?.exists === true) {
    await tryQuery(client, alterLoginPasswordSql(role, password), `ALTER ROLE ${role}`);
    return;
  }
  await client.query(createLoginRoleSql(role, password));
}

export async function bootstrapHostedRoles(): Promise<void> {
  const { app: appUrl, migration: migrationUrl } = loadBootstrapConnectionStrings();

  const app = parsePostgresUrl(appUrl);
  const migrator = parsePostgresUrl(migrationUrl);
  if (postgresRoleName(app.user) !== APP_ROLE) {
    throw new Error(`SG_DATABASE_URL user must be ${APP_ROLE}; migrations grant to that role`);
  }

  const migratorPassword =
    postgresRoleName(migrator.user) === MIGRATOR_ROLE
      ? migrator.password
      : randomBytes(32).toString("base64");

  const client = new pg.Client(pgConnectOptions(migrationUrl));
  await client.connect();
  try {
    const dbName = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0]
      ?.db;
    if (dbName === undefined || dbName.length === 0) {
      throw new Error("could not read current_database()");
    }

    await ensureLoginRole(client, APP_ROLE, app.password);
    await ensureLoginRole(client, MIGRATOR_ROLE, migratorPassword);

    const db = quoteIdent(dbName);
    await tryQuery(
      client,
      `GRANT CONNECT ON DATABASE ${db} TO ${quoteIdent(APP_ROLE)}`,
      "GRANT CONNECT to sg_app",
    );
    await tryQuery(
      client,
      `GRANT CONNECT ON DATABASE ${db} TO ${quoteIdent(MIGRATOR_ROLE)}`,
      "GRANT CONNECT to sg_migrator",
    );
    await tryQuery(
      client,
      `GRANT CREATE ON DATABASE ${db} TO ${quoteIdent(MIGRATOR_ROLE)}`,
      "GRANT CREATE ON DATABASE",
    );
    await tryQuery(
      client,
      `GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)}, ${quoteIdent(MIGRATOR_ROLE)}`,
      "GRANT USAGE ON SCHEMA public",
    );
    await tryQuery(
      client,
      `GRANT CREATE ON SCHEMA public TO ${quoteIdent(MIGRATOR_ROLE)}`,
      "GRANT CREATE ON SCHEMA public",
    );
  } finally {
    await client.end();
  }
}
