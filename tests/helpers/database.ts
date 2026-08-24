import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";

export function appDatabaseUrl(): string {
  const url = process.env["SG_DATABASE_URL"];
  if (url === undefined) throw new Error("SG_DATABASE_URL is not set");
  return url;
}

export function migrationDatabaseUrl(): string {
  const url = process.env["SG_MIGRATION_DATABASE_URL"];
  if (url === undefined) throw new Error("SG_MIGRATION_DATABASE_URL is not set");
  return url;
}

export function openAppDatabase(): DatabaseHandle {
  return createDatabase(appDatabaseUrl(), 5);
}

export interface SeededProduct {
  tenantId: string;
  productId: string;
  endUserId: string;
  conversationId: string;
}

export async function seedProduct(name: string): Promise<SeededProduct> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      "INSERT INTO tenant (name) VALUES ($1) RETURNING id",
      [name],
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error("tenant insert returned no row");

    const product = await client.query<{ id: string }>(
      `INSERT INTO product
         (tenant_id, name, origin_allowlist, jwt_algorithms, route_registry,
          redaction_allowlist, grounded_actions_enabled, retention_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        tenantId,
        `${name} product`,
        ["https://app.example"],
        ["RS256"],
        JSON.stringify({ routes: [] }),
        JSON.stringify({ fieldNames: [] }),
        false,
        90,
      ],
    );
    const productId = product.rows[0]?.id;
    if (productId === undefined) throw new Error("product insert returned no row");

    const endUser = await client.query<{ id: string }>(
      "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, $3, $4) RETURNING id",
      [productId, `user-${randomUUID()}`, "verified", ["billing:write"]],
    );
    const endUserId = endUser.rows[0]?.id;
    if (endUserId === undefined) throw new Error("end_user insert returned no row");

    const conversation = await client.query<{ id: string }>(
      "INSERT INTO conversation (product_id, end_user_id, status, resolution_state) VALUES ($1, $2, 'open', 'in_progress') RETURNING id",
      [productId, endUserId],
    );
    const conversationId = conversation.rows[0]?.id;
    if (conversationId === undefined) throw new Error("conversation insert returned no row");

    return { tenantId, productId, endUserId, conversationId };
  } finally {
    await client.end();
  }
}

export async function insertStepAsMigrator(
  productId: string,
  conversationId: string,
  seq: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO step
         (conversation_id, product_id, turn_id, seq, ladder_level, action,
          policy_verdict, result, expect_outcome)
       VALUES ($1, $2, $3, $4, 'L1', $5, $6, $7, $8)`,
      [
        conversationId,
        productId,
        randomUUID(),
        seq,
        JSON.stringify({ type: "call_api" }),
        JSON.stringify({ decision: "allow" }),
        JSON.stringify({ status: "ok" }),
        JSON.stringify({ satisfied: true, evaluatedBy: "rules", detail: "seeded" }),
      ],
    );
  } finally {
    await client.end();
  }
}
