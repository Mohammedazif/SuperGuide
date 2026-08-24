import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "../public/primitives.js";

export const tenantSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  createdAt: isoTimestampSchema,
  deletedAt: isoTimestampSchema.nullable(),
});
export type Tenant = z.infer<typeof tenantSchema>;

export const jwtAlgorithmSchema = z.enum(["RS256", "EdDSA"]);
export type JwtAlgorithm = z.infer<typeof jwtAlgorithmSchema>;

export const routeRegistrySchema = z.object({
  routes: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      template: z.string().min(1),
      params: z.array(z.string()),
      requiresScopes: z.array(z.string()),
    }),
  ),
});
export type RouteRegistry = z.infer<typeof routeRegistrySchema>;

export const redactionAllowlistSchema = z.object({
  fieldNames: z.array(z.string()),
});
export type RedactionAllowlist = z.infer<typeof redactionAllowlistSchema>;

export const productSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string().min(1),
  originAllowlist: z.array(z.string()),
  jwksUrl: z.url().nullable(),
  jwtIssuer: z.string().nullable(),
  jwtAudience: z.string().nullable(),
  jwtAlgorithms: z.array(jwtAlgorithmSchema),
  routeRegistry: routeRegistrySchema,
  redactionAllowlist: redactionAllowlistSchema,
  groundedActionsEnabled: z.boolean(),
  retentionDays: z.int().positive(),
  apiBaseUrl: z.url().nullable(),
  escalationWebhookUrl: z.url().nullable(),
  escalationEmail: z.email().nullable(),
  createdAt: isoTimestampSchema,
  deletedAt: isoTimestampSchema.nullable(),
});
export type Product = z.infer<typeof productSchema>;

export const productSecretMetadataSchema = z.object({
  productId: uuidSchema,
  signingPublicKey: z.string().nullable(),
  rotatedAt: isoTimestampSchema.nullable(),
  hasApiCredentials: z.boolean(),
});
export type ProductSecretMetadata = z.infer<typeof productSecretMetadataSchema>;
