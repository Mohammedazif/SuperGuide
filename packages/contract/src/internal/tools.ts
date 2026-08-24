import { z } from "zod";
import { expectPredicateSchema } from "../public/expect.js";
import { riskClassSchema, uuidSchema } from "../public/primitives.js";

export const toolKindSchema = z.enum(["api", "capability", "route"]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const httpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const apiToolDefinitionSchema = z.object({
  kind: z.literal("api"),
  operationId: z.string().min(1),
  method: httpMethodSchema,
  path: z.string().min(1),
  description: z.string(),
  parameterSchema: z.record(z.string(), z.unknown()),
  pathParams: z.array(z.string()),
  queryParams: z.array(z.string()),
  bodyParams: z.array(z.string()),
});

export const capabilityToolDefinitionSchema = z.object({
  kind: z.literal("capability"),
  capability: z.string().min(1),
  description: z.string(),
  parameterSchema: z.record(z.string(), z.unknown()),
});

export const routeToolDefinitionSchema = z.object({
  kind: z.literal("route"),
  routeId: z.string().min(1),
  template: z.string().min(1),
  description: z.string(),
  parameterSchema: z.record(z.string(), z.unknown()),
});

export const toolDefinitionSchema = z.discriminatedUnion("kind", [
  apiToolDefinitionSchema,
  capabilityToolDefinitionSchema,
  routeToolDefinitionSchema,
]);
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolRecordSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  name: z.string().min(1),
  kind: toolKindSchema,
  riskClass: riskClassSchema,
  definition: toolDefinitionSchema,
  expectTemplate: z.array(expectPredicateSchema),
  enabled: z.boolean(),
});
export type ToolRecord = z.infer<typeof toolRecordSchema>;
