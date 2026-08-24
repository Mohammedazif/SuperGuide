import { z } from "zod";

const fixtureEnvironmentSchema = z.object({
  FIXTURE_PORT: z.coerce.number().int().positive().max(65535).default(8099),
  FIXTURE_WIDGET_URL: z.string().nullable().default(null),
  FIXTURE_PRODUCT_ID: z.string().nullable().default(null),
  FIXTURE_API_URL: z.string().nullable().default(null),
  FIXTURE_STRICT_CSP: z.stringbool().default(false),
});

export type FixtureEnvironment = z.infer<typeof fixtureEnvironmentSchema>;

export function loadFixtureEnvironment(): FixtureEnvironment {
  const parsed = fixtureEnvironmentSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  process.stderr.write(`Invalid fixture environment:\n${parsed.error.message}\n`);
  process.exit(1);
}
