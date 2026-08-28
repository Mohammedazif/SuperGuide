import type { ClientConfig, PoolConfig } from "pg";

export function pgConnectOptions(connectionString: string): ClientConfig & PoolConfig {
  return { connectionString, family: 4 };
}

export function explainPgConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(message)) return message;
  return (
    `${message}\n` +
    "Render cannot reach Supabase's IPv6-only direct host. In Supabase → Connect, copy the " +
    "Session pooler URI (host *.pooler.supabase.com, port 5432, user postgres.<project-ref>). " +
    "Do not use db.<ref>.supabase.co or port 6543."
  );
}
