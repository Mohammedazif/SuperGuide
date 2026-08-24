import { z } from "zod";

function base64Key(minimumBytes: number, exactBytes?: number) {
  return z.string().refine(
    (value) => {
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return false;
      if (exactBytes !== undefined) return decoded.length === exactBytes;
      return decoded.length >= minimumBytes;
    },
    {
      message:
        exactBytes === undefined
          ? `must be base64 encoding at least ${minimumBytes} bytes`
          : `must be base64 encoding exactly ${exactBytes} bytes`,
    },
  );
}

export const environmentSchema = z.object({
  SG_DATABASE_URL: z.url(),
  SG_MIGRATION_DATABASE_URL: z.url().optional(),
  SG_PORT: z.coerce.number().int().positive().max(65535).default(8080),
  SG_PUBLIC_ORIGIN: z.url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  SG_SESSION_SIGNING_KEY: base64Key(32),
  SG_SECRET_ENCRYPTION_KEY: base64Key(32, 32),
  SG_WEBHOOK_SIGNING_KEY: base64Key(32),
  SG_ENABLE_GROUNDED_ACTIONS: z.stringbool().default(false),
  SG_STEP_BUDGET: z.coerce.number().int().positive().max(64).default(12),
  SG_LOG_LEVEL: z.enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: Record<string, string | undefined>): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new EnvironmentError(`Invalid environment:\n${issues}`);
}

export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

export function loadMigrationConnectionString(): string {
  const source = process.env;
  const url = source["SG_MIGRATION_DATABASE_URL"] ?? source["SG_DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new EnvironmentError("SG_MIGRATION_DATABASE_URL or SG_DATABASE_URL must be set");
  }
  return url;
}

export function loadEnvironmentOrExit(): Environment {
  try {
    return parseEnvironment(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
