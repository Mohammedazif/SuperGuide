import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Repo-root .env: src/dist sit two levels down; pnpm --filter cwd misses --env-file=.env.
const REPO_ROOT_ENV = join(dirname(fileURLToPath(import.meta.url)), "../../../.env");

function loadRepoDotEnv(): void {
  if (existsSync(REPO_ROOT_ENV)) {
    process.loadEnvFile(REPO_ROOT_ENV);
  }
}

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

const KEY_OF_PROVIDER = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
} as const;

const commaSeparatedOrigins = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine((entries) => entries.length > 0, { message: "must list at least one extension origin" });

export const environmentSchema = z
  .object({
    SG_DATABASE_URL: z.url(),
    SG_MIGRATION_DATABASE_URL: z.url().optional(),
    SG_PORT: z.coerce.number().int().positive().max(65535).default(8080),
    SG_PUBLIC_ORIGIN: z.url(),
    SG_MODEL_PROVIDER: z.enum(["anthropic", "openai", "gemini"]).default("anthropic"),
    ANTHROPIC_API_KEY: z.string().default(""),
    OPENAI_API_KEY: z.string().default(""),
    GEMINI_API_KEY: z.string().default(""),
    SG_SESSION_SIGNING_KEY: base64Key(32),
    SG_SECRET_ENCRYPTION_KEY: base64Key(32, 32),
    SG_WEBHOOK_SIGNING_KEY: base64Key(32),
    SG_ENABLE_GROUNDED_ACTIONS: z.stringbool().default(false),
    SG_STEP_BUDGET: z.coerce.number().int().positive().max(64).default(12),
    SG_LOG_LEVEL: z
      .enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    SG_DEVICE_SIGNING_KEY: base64Key(32),
    SG_DAILY_TASK_QUOTA: z.coerce.number().int().min(0).default(20),
    SG_DAILY_IP_QUOTA: z.coerce.number().int().min(0).default(200),
    SG_ALLOWED_EXTENSION_IDS: commaSeparatedOrigins,
    SG_ANYWHERE_AGENT: z.enum(["on", "off"]).default("on"),
    SG_ADAPTERS: z.enum(["on", "off"]).default("on"),
  })
  .superRefine((value, context) => {
    const keyName = KEY_OF_PROVIDER[value.SG_MODEL_PROVIDER];
    if (value[keyName].length === 0) {
      context.addIssue({
        code: "custom",
        path: [keyName],
        message: `must be set when SG_MODEL_PROVIDER=${value.SG_MODEL_PROVIDER}`,
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

// Render injects PORT and RENDER_EXTERNAL_URL. Do not set SG_PORT in the Blueprint.
export function withPlatformDefaults(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const port = nonempty(source["SG_PORT"]) ?? nonempty(source["PORT"]);
  const origin = nonempty(source["SG_PUBLIC_ORIGIN"]) ?? nonempty(source["RENDER_EXTERNAL_URL"]);
  return {
    ...source,
    ...(port === undefined ? {} : { SG_PORT: port }),
    ...(origin === undefined ? {} : { SG_PUBLIC_ORIGIN: origin }),
  };
}

export function parseEnvironment(source: Record<string, string | undefined>): Environment {
  const parsed = environmentSchema.safeParse(withPlatformDefaults(source));
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
  loadRepoDotEnv();
  const source = process.env;
  const url = source["SG_MIGRATION_DATABASE_URL"] ?? source["SG_DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new EnvironmentError("SG_MIGRATION_DATABASE_URL or SG_DATABASE_URL must be set");
  }
  return url;
}

export function shouldBootstrapRoles(): boolean {
  loadRepoDotEnv();
  const flag = (process.env["SG_BOOTSTRAP_ROLES"] ?? "1").toLowerCase();
  return flag !== "0" && flag !== "false";
}

export function loadBootstrapConnectionStrings(): { app: string; migration: string } {
  loadRepoDotEnv();
  const app = process.env["SG_DATABASE_URL"];
  const migration = process.env["SG_MIGRATION_DATABASE_URL"];
  if (app === undefined || app.length === 0) {
    throw new EnvironmentError("SG_DATABASE_URL must be set to bootstrap roles");
  }
  if (migration === undefined || migration.length === 0) {
    throw new EnvironmentError("SG_MIGRATION_DATABASE_URL must be set to bootstrap roles");
  }
  return { app, migration };
}

export function loadEnvironmentOrExit(): Environment {
  loadRepoDotEnv();
  try {
    return parseEnvironment(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
