import { z } from "zod";
import { anywhereRiskClassSchema, hostSchema } from "./core.js";
import { expectPredicateSchema, targetDescriptorSchema } from "./predicate.js";

const paramNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);

export const adapterValueSchema = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("param"), name: paramNameSchema }),
  z.strictObject({ from: z.literal("literal"), value: z.string() }),
]);
export type AdapterValue = z.infer<typeof adapterValueSchema>;

export const adapterStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), target: targetDescriptorSchema }),
  z.strictObject({
    action: z.literal("type"),
    target: targetDescriptorSchema,
    value: adapterValueSchema,
  }),
  z.strictObject({
    action: z.literal("select"),
    target: targetDescriptorSchema,
    value: adapterValueSchema,
  }),
  z.strictObject({
    action: z.literal("check"),
    target: targetDescriptorSchema,
    checked: z.boolean(),
  }),
  z.strictObject({ action: z.literal("navigate"), route: z.string().startsWith("/") }),
  z.strictObject({
    action: z.literal("waitFor"),
    predicate: expectPredicateSchema,
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  }),
]);
export type AdapterStep = z.infer<typeof adapterStepSchema>;

export const adapterRouteSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  template: z.string().startsWith("/"),
  params: z.array(paramNameSchema),
});
export type AdapterRoute = z.infer<typeof adapterRouteSchema>;

export const adapterCapabilitySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  description: z.string().min(1),
  risk: anywhereRiskClassSchema,
  route: z.string().startsWith("/"),
  params: z.array(z.strictObject({ name: paramNameSchema, description: z.string().min(1) })),
  steps: z.array(adapterStepSchema).min(1),
  expect: z.array(expectPredicateSchema).min(1),
});
export type AdapterCapability = z.infer<typeof adapterCapabilitySchema>;

export const siteAdapterSchema = z.strictObject({
  host: hostSchema,
  version: z.number().int().min(1),
  routes: z.array(adapterRouteSchema),
  capabilities: z.array(adapterCapabilitySchema),
});
export type SiteAdapter = z.infer<typeof siteAdapterSchema>;

export const adapterSetSchema = z.strictObject({
  version: z.number().int().min(1),
  adapters: z.array(siteAdapterSchema),
});
export type AdapterSet = z.infer<typeof adapterSetSchema>;
