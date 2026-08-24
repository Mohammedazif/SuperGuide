import { and, eq } from "drizzle-orm";
import type { IdentityTier } from "@superguide/contract/public";
import type { Transaction } from "../db/client.js";
import { endUser } from "../db/schema.js";

export interface EndUserRow {
  id: string;
  externalId: string | null;
  identityTier: IdentityTier;
  scopes: string[];
}

export async function createAnonymousEndUser(
  tx: Transaction,
  productId: string,
): Promise<EndUserRow> {
  const inserted = await tx
    .insert(endUser)
    .values({ productId, externalId: null, identityTier: "anonymous", scopes: [] })
    .returning();

  const row = inserted[0];
  if (row === undefined) throw new Error("end_user insert returned no row");
  return {
    id: row.id,
    externalId: row.externalId,
    identityTier: "anonymous",
    scopes: row.scopes,
  };
}

export async function upsertIdentifiedEndUser(
  tx: Transaction,
  productId: string,
  externalId: string,
  tier: IdentityTier,
  scopes: string[],
): Promise<EndUserRow> {
  const existing = await tx
    .select()
    .from(endUser)
    .where(and(eq(endUser.productId, productId), eq(endUser.externalId, externalId)))
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    const updated = await tx
      .update(endUser)
      .set({ identityTier: tier, scopes, lastSeen: new Date() })
      .where(eq(endUser.id, found.id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new Error("end_user update returned no row");
    return { id: row.id, externalId: row.externalId, identityTier: tier, scopes: row.scopes };
  }

  const inserted = await tx
    .insert(endUser)
    .values({ productId, externalId, identityTier: tier, scopes })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error("end_user insert returned no row");
  return { id: row.id, externalId: row.externalId, identityTier: tier, scopes: row.scopes };
}
