import { type z } from "zod";
import { routeRegistrySchema } from "@superguide/contract/internal";
import type { Transaction } from "../db/client.js";
import { product as productTable, tool as toolTable } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { ingestOpenApi } from "../tools/ingest-openapi.js";

export interface OnboardInput {
  productId: string;
  openApiUrl: string;
  routeRegistryUrl: string | null;
  apiBaseUrlOverride: string | null;
}

export interface OnboardOutcome {
  toolsDiscovered: number;
  toolsAwaitingReview: number;
  routesDiscovered: number;
  apiBaseUrl: string | null;
  skipped: string[];
}

export interface OnboardDependencies {
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
}

async function fetchJson(
  url: string,
  deps: OnboardDependencies,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const perform = deps.fetchImplementation ?? fetch;
  try {
    const response = await perform(url, { signal: deps.signal, headers: { accept: "application/json" } });
    if (!response.ok) return { ok: false, reason: `${url} replied with ${String(response.status)}` };
    return { ok: true, value: (await response.json()) };
  } catch (error) {
    return {
      ok: false,
      reason: `${url} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class OnboardingFailure extends Error {
  override readonly name = "OnboardingFailure";
}

// Onboarding is data, not code: a published OpenAPI document and a route table are enough to
// give an agent a product's whole level-one and level-three surface. Every discovered tool
// arrives disabled and is reviewed in the console before it can be called.
export async function onboardProduct(
  tx: Transaction,
  input: OnboardInput,
  deps: OnboardDependencies,
): Promise<OnboardOutcome> {
  const specResult = await fetchJson(input.openApiUrl, deps);
  if (!specResult.ok) throw new OnboardingFailure(specResult.reason);

  const ingested = ingestOpenApi(specResult.value);
  if (!ingested.ok) throw new OnboardingFailure(ingested.reason);

  let routes: z.infer<typeof routeRegistrySchema> = { routes: [] };
  if (input.routeRegistryUrl !== null) {
    const routeResult = await fetchJson(input.routeRegistryUrl, deps);
    if (!routeResult.ok) throw new OnboardingFailure(routeResult.reason);
    const parsed = routeRegistrySchema.safeParse(routeResult.value);
    if (!parsed.success) throw new OnboardingFailure("the route registry failed validation");
    routes = parsed.data;
  }

  const apiBaseUrl = input.apiBaseUrlOverride ?? ingested.serverUrl;

  await tx
    .update(productTable)
    .set({ routeRegistry: routes, apiBaseUrl })
    .where(eq(productTable.id, input.productId));

  let awaitingReview = 0;

  for (const discovered of ingested.tools) {
    const existing = await tx
      .select()
      .from(toolTable)
      .where(and(eq(toolTable.productId, input.productId), eq(toolTable.name, discovered.record.name)))
      .limit(1);

    const found = existing[0];
    if (found === undefined) {
      await tx.insert(toolTable).values({
        productId: input.productId,
        name: discovered.record.name,
        kind: discovered.record.kind,
        riskClass: discovered.record.riskClass,
        definition: discovered.record.definition,
        expectTemplate: discovered.record.expectTemplate,
        enabled: false,
      });
      awaitingReview += 1;
      continue;
    }

    const changed =
      found.riskClass !== discovered.record.riskClass ||
      JSON.stringify(found.definition) !== JSON.stringify(discovered.record.definition);

    await tx
      .update(toolTable)
      .set({
        riskClass: discovered.record.riskClass,
        definition: discovered.record.definition,
        expectTemplate: discovered.record.expectTemplate,
        ...(changed ? { enabled: false } : {}),
      })
      .where(eq(toolTable.id, found.id));

    if (changed || !found.enabled) awaitingReview += 1;
  }

  return {
    toolsDiscovered: ingested.tools.length,
    toolsAwaitingReview: awaitingReview,
    routesDiscovered: routes.routes.length,
    apiBaseUrl,
    skipped: ingested.skipped,
  };
}
