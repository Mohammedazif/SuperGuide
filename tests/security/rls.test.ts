import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import {
  appDatabaseUrl,
  insertStepAsMigrator,
  openAppDatabase,
  seedProduct,
  type SeededProduct,
} from "../helpers/database.js";

function causeMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

const RLS_TABLES = [
  "product",
  "product_secret",
  "procedure",
  "tool",
  "document",
  "chunk",
  "end_user",
  "conversation",
  "message",
  "step",
] as const;

describe("row level security", () => {
  let handle: DatabaseHandle;
  let alpha: SeededProduct;
  let beta: SeededProduct;

  beforeAll(async () => {
    handle = openAppDatabase();
    alpha = await seedProduct("alpha");
    beta = await seedProduct("beta");
    await insertStepAsMigrator(alpha.productId, alpha.conversationId, 1);
    await insertStepAsMigrator(beta.productId, beta.conversationId, 1);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("scopes reads to the product named in the transaction", async () => {
    const rows = await withProduct(handle.db, alpha.productId, async (tx) => {
      const result = await tx.execute<{ id: string; product_id: string }>(
        sql`SELECT id, product_id FROM step`,
      );
      return result.rows;
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.product_id).toBe(alpha.productId);
  });

  it("hides every other tenant's rows on every protected table", async () => {
    for (const table of RLS_TABLES) {
      const visible = await withProduct(handle.db, alpha.productId, async (tx) => {
        const result = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}
              WHERE ${sql.identifier(table === "product" ? "id" : "product_id")} = ${beta.productId}::uuid`,
        );
        return Number(result.rows[0]?.n ?? "-1");
      });
      expect({ table, visible }).toEqual({ table, visible: 0 });
    }
  });

  it("a connection that never sets sg.product_id reads zero rows, not every row", async () => {
    const client = new pg.Client({ connectionString: appDatabaseUrl() });
    await client.connect();
    try {
      for (const table of RLS_TABLES) {
        const result = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table}`,
        );
        expect({ table, rows: Number(result.rows[0]?.n) }).toEqual({ table, rows: 0 });
      }

      const scope = await client.query<{ value: string | null }>(
        "SELECT sg_current_product_id()::text AS value",
      );
      expect(scope.rows[0]?.value).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("does not leak the product_id setting across pooled connections", async () => {
    await withProduct(handle.db, alpha.productId, async (tx) => {
      const inside = await tx.execute<{ value: string | null }>(
        sql`SELECT current_setting('sg.product_id', true) AS value`,
      );
      expect(inside.rows[0]?.value).toBe(alpha.productId);
      return null;
    });

    const after = await handle.db.execute<{ value: string | null }>(
      sql`SELECT sg_current_product_id()::text AS value`,
    );
    expect(after.rows[0]?.value).toBeNull();

    const readable = await handle.db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM step`);
    expect(Number(readable.rows[0]?.n)).toBe(0);
  });

  it("refuses writes that would place a row in another product", async () => {
    await expect(
      withProduct(handle.db, alpha.productId, async (tx) => {
        await tx.execute(
          sql`INSERT INTO message (conversation_id, product_id, role, content, seq)
              VALUES (${beta.conversationId}::uuid, ${beta.productId}::uuid, 'user', '{"text":"x"}'::jsonb, 99)`,
        );
        return null;
      }),
    ).rejects.toSatisfy(
      (error: unknown) => causeMessage(error).includes("row-level security"),
      "rejects with a row-level security violation",
    );
  });

  it("keeps step append-only for the application role", async () => {
    await expect(
      withProduct(handle.db, alpha.productId, async (tx) => {
        await tx.execute(sql`UPDATE step SET latency_ms = 1 WHERE product_id = ${alpha.productId}::uuid`);
        return null;
      }),
    ).rejects.toThrow();

    await expect(
      withProduct(handle.db, alpha.productId, async (tx) => {
        await tx.execute(sql`DELETE FROM step WHERE product_id = ${alpha.productId}::uuid`);
        return null;
      }),
    ).rejects.toThrow();
  });

  it("does not run the application as a table owner or with BYPASSRLS", async () => {
    const client = new pg.Client({ connectionString: appDatabaseUrl() });
    await client.connect();
    try {
      const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });

      const owned = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_tables
          WHERE schemaname = 'public' AND tableowner = current_user`,
      );
      expect(Number(owned.rows[0]?.n)).toBe(0);
    } finally {
      await client.end();
    }
  });
});
