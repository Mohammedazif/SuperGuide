import type { ClientConfig, PoolConfig } from "pg";

function hostedPostgres(connectionString: string): boolean {
  return (
    connectionString.includes("supabase.co") || connectionString.includes("pooler.supabase.com")
  );
}

export function pgConnectOptions(connectionString: string): ClientConfig & PoolConfig {
  if (!hostedPostgres(connectionString)) return { connectionString };
  // pg treats sslmode=require as verify-full; the pooler chain is not in Node's CA list.
  return { connectionString, ssl: { rejectUnauthorized: false } };
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
    return `${message}\nHosted Postgres TLS could not be verified. Use the Session pooler URI.`;
  }
  return message;
}
