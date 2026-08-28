import { and, eq } from "drizzle-orm";
import type { CapabilityDescriptor } from "@superguide/contract/public";
import { toolRecordSchema, type ToolRecord } from "@superguide/contract/internal";
import type { Transaction } from "../db/client.js";
import { tool } from "../db/schema.js";
import { stableStringify } from "../model/stable-json.js";

export interface CapabilityRegistrationOutcome {
  registered: string[];
  awaitingReview: string[];
}

// Customer-registered; arrive disabled until a lead enables them. The model never invents them.
export async function registerCapabilities(
  tx: Transaction,
  productId: string,
  descriptors: readonly CapabilityDescriptor[],
): Promise<CapabilityRegistrationOutcome> {
  const registered: string[] = [];
  const awaitingReview: string[] = [];

  for (const descriptor of descriptors) {
    const name = `capability_${descriptor.name}`;
    const definition = {
      kind: "capability" as const,
      capability: descriptor.name,
      description: descriptor.description,
      parameterSchema: descriptor.parameters,
    };

    const existing = await tx
      .select()
      .from(tool)
      .where(and(eq(tool.productId, productId), eq(tool.name, name)))
      .limit(1);

    const found = existing[0];
    if (found === undefined) {
      await tx.insert(tool).values({
        productId,
        name,
        kind: "capability",
        riskClass: descriptor.risk,
        definition,
        expectTemplate: [{ kind: "capability_status", status: "ok" }],
        enabled: false,
      });
      awaitingReview.push(descriptor.name);
      continue;
    }

    // jsonb key order is unstable; plain stringify looks like a change, disabling reviewed tools.
    const changed =
      found.riskClass !== descriptor.risk ||
      stableStringify(found.definition) !== stableStringify(definition);

    await tx
      .update(tool)
      .set({
        riskClass: descriptor.risk,
        definition,
        ...(changed ? { enabled: false } : {}),
      })
      .where(eq(tool.id, found.id));

    if (changed || !found.enabled) awaitingReview.push(descriptor.name);
    else registered.push(descriptor.name);
  }

  return { registered, awaitingReview };
}

export async function listEnabledTools(
  tx: Transaction,
  productId: string,
): Promise<ToolRecord[]> {
  const rows = await tx
    .select()
    .from(tool)
    .where(and(eq(tool.productId, productId), eq(tool.enabled, true)));

  return rows.map((row) =>
    toolRecordSchema.parse({
      id: row.id,
      productId: row.productId,
      name: row.name,
      kind: row.kind,
      riskClass: row.riskClass,
      definition: row.definition,
      expectTemplate: row.expectTemplate,
      enabled: row.enabled,
    }),
  );
}
