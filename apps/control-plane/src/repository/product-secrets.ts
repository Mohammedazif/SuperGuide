import { eq } from "drizzle-orm";
import type { Transaction } from "../db/client.js";
import { productSecret } from "../db/schema.js";
import type { SealedCredentials } from "../secrets/credentials.js";

export async function loadProductSecret(
  tx: Transaction,
  productId: string,
): Promise<SealedCredentials | null> {
  const rows = await tx
    .select()
    .from(productSecret)
    .where(eq(productSecret.productId, productId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.apiCredentialsCiphertext === null || row.apiCredentialsIv === null) return null;
  return { ciphertext: row.apiCredentialsCiphertext, iv: row.apiCredentialsIv };
}

export async function loadSigningPublicKey(
  tx: Transaction,
  productId: string,
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(productSecret)
    .where(eq(productSecret.productId, productId))
    .limit(1);
  return rows[0]?.signingPublicKey ?? null;
}
