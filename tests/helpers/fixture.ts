import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildFixtureApp } from "../../apps/fixture-app/src/server.js";
import { openApiDocument, FIXTURE_ROUTE_REGISTRY } from "../../apps/fixture-app/src/openapi.js";
import { ingestOpenApi } from "../../apps/control-plane/src/tools/ingest-openapi.js";
import { sealCredentials } from "../../apps/control-plane/src/secrets/credentials.js";
import { migrationDatabaseUrl } from "./database.js";

export interface RunningFixture {
  app: FastifyInstance;
  baseUrl: string;
  state: ReturnType<typeof buildFixtureApp>["state"];
  reset: () => void;
  close: () => Promise<void>;
}

export async function startFixtureApp(
  options: Parameters<typeof buildFixtureApp>[0] = {},
): Promise<RunningFixture> {
  const fixture = buildFixtureApp(options);
  await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  const address = fixture.app.server.address();
  if (address === null || typeof address === "string") throw new Error("no bound port");

  return {
    app: fixture.app,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get state() {
      return fixture.state;
    },
    reset: () => {
      fixture.reset();
    },
    close: async () => {
      await fixture.app.close();
    },
  };
}

export interface IngestOptions {
  productId: string;
  apiBaseUrl: string;
  enableToolNames?: string[];
  credentialsKey?: Buffer;
}

export async function ingestFixtureTools(options: IngestOptions): Promise<string[]> {
  const outcome = ingestOpenApi(openApiDocument(options.apiBaseUrl));
  if (!outcome.ok) throw new Error(outcome.reason);

  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query("UPDATE product SET api_base_url = $1, route_registry = $2 WHERE id = $3", [
      options.apiBaseUrl,
      JSON.stringify(FIXTURE_ROUTE_REGISTRY),
      options.productId,
    ]);

    const enabled = new Set(options.enableToolNames ?? outcome.tools.map((t) => t.record.name));

    for (const tool of outcome.tools) {
      await client.query(
        `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (product_id, name) DO UPDATE
           SET definition = EXCLUDED.definition,
               risk_class = EXCLUDED.risk_class,
               expect_template = EXCLUDED.expect_template,
               enabled = EXCLUDED.enabled`,
        [
          options.productId,
          tool.record.name,
          tool.record.kind,
          tool.record.riskClass,
          JSON.stringify(tool.record.definition),
          JSON.stringify(tool.record.expectTemplate),
          enabled.has(tool.record.name),
        ],
      );
    }

    if (options.credentialsKey !== undefined) {
      const sealed = sealCredentials(options.credentialsKey, {
        kind: "bearer",
        token: "fixture-secret-token-value-do-not-log",
      });
      await client.query(
        `INSERT INTO product_secret (product_id, api_credentials_ciphertext, api_credentials_iv, rotated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (product_id) DO UPDATE
           SET api_credentials_ciphertext = EXCLUDED.api_credentials_ciphertext,
               api_credentials_iv = EXCLUDED.api_credentials_iv`,
        [options.productId, sealed.ciphertext, sealed.iv],
      );
    }

    return outcome.tools.map((tool) => tool.record.name);
  } finally {
    await client.end();
  }
}

export async function insertProcedure(
  productId: string,
  slug: string,
  sourceYaml: string,
  body: unknown,
  version = 1,
): Promise<void> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO procedure (product_id, slug, version, body, source_yaml, active, created_by)
       VALUES ($1, $2, $3, $4, $5, true, 'test')`,
      [productId, slug, version, JSON.stringify(body), sourceYaml],
    );
  } finally {
    await client.end();
  }
}

export async function enableCapability(
  productId: string,
  name: string,
  risk: string,
  parameters: Record<string, unknown>,
  description: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
       VALUES ($1, $2, 'capability', $3, $4, $5, true)
       ON CONFLICT (product_id, name) DO UPDATE
         SET risk_class = EXCLUDED.risk_class,
             definition = EXCLUDED.definition,
             enabled = true`,
      [
        productId,
        `capability_${name}`,
        risk,
        JSON.stringify({
          kind: "capability",
          capability: name,
          description,
          parameterSchema: parameters,
        }),
        JSON.stringify([{ kind: "capability_status", status: "ok" }]),
      ],
    );
  } finally {
    await client.end();
  }
}
