import { eq, isNull, and } from "drizzle-orm";
import {
  productSchema,
  routeRegistrySchema,
  redactionAllowlistSchema,
  type Product,
} from "@superguide/contract/internal";
import type { Transaction } from "../db/client.js";
import { product } from "../db/schema.js";

export async function findProduct(tx: Transaction, productId: string): Promise<Product | null> {
  const rows = await tx
    .select()
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return productSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    originAllowlist: row.originAllowlist,
    jwksUrl: row.jwksUrl,
    jwtIssuer: row.jwtIssuer,
    jwtAudience: row.jwtAudience,
    jwtAlgorithms: row.jwtAlgorithms,
    routeRegistry: routeRegistrySchema.parse(row.routeRegistry),
    redactionAllowlist: redactionAllowlistSchema.parse(row.redactionAllowlist),
    groundedActionsEnabled: row.groundedActionsEnabled,
    retentionDays: row.retentionDays,
    apiBaseUrl: row.apiBaseUrl,
    escalationWebhookUrl: row.escalationWebhookUrl,
    escalationEmail: row.escalationEmail,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  });
}
