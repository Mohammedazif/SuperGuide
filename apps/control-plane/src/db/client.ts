import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDatabase(connectionString: string, maxConnections = 10): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  const db: Database = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export async function withProduct<T>(
  db: Database,
  productId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('sg.product_id', ${productId}, true)`);
    return fn(tx);
  });
}

export async function allocateSeq(tx: Transaction, conversationId: string): Promise<number> {
  const result = await tx.execute<{ seq: string }>(
    sql`SELECT sg_allocate_seq(${conversationId}::uuid) AS seq`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("sequence allocation returned no row");
  return Number(row.seq);
}
