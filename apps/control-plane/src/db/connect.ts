import type { ClientConfig, PoolConfig } from "pg";

export interface PostgresLocation {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

export function parsePostgresUrl(connectionString: string): PostgresLocation {
  let parsed: URL;
  try {
    parsed = new URL(connectionString.replace(/^postgres(?:ql)?:/i, "http:"));
  } catch {
    throw new Error("database URL is not a valid postgres URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")).split("/")[0] ?? "";
  if (database.length === 0) throw new Error("postgres URL must include a database name");
  const port = parsed.port.length > 0 ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0) throw new Error("postgres URL port is invalid");
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: decodeURIComponent(parsed.hostname),
    port,
    database,
  };
}

function hostedPostgres(host: string): boolean {
  return host.endsWith("supabase.co") || host.endsWith("pooler.supabase.com");
}

export function pgConnectOptions(connectionString: string): ClientConfig & PoolConfig {
  const parsed = parsePostgresUrl(connectionString);
  const options: ClientConfig & PoolConfig = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
  };
  // Never pass connectionString: pg-connection-string maps sslmode=require to verify-full
  // and overwrites an explicit ssl object.
  if (hostedPostgres(parsed.host)) {
    options.ssl = { rejectUnauthorized: false };
  }
  return options;
}

export function explainPgConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(message)) {
    return (
      `${message}\n` +
      "Render cannot reach Supabase's IPv6-only direct host. In Supabase → Connect, copy the " +
      "Session pooler URI (host *.pooler.supabase.com, port 5432, user postgres.<project-ref>). " +
      "Do not use db.<ref>.supabase.co or port 6543."
    );
  }
  if (/self-signed certificate/i.test(message)) {
    return `${message}\nHosted Postgres TLS handshake failed.`;
  }
  return message;
}
