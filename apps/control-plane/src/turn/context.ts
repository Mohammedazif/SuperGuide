import { and, asc, eq } from "drizzle-orm";
import { toolRecordSchema, type Product, type ToolRecord } from "@superguide/contract/internal";
import type { Transaction } from "../db/client.js";
import { procedure, tool } from "../db/schema.js";
import { message } from "../db/schema.js";
import { findProduct } from "../repository/products.js";

export interface ProcedureCandidate {
  slug: string;
  version: number;
  title: string;
  when: string;
  body: unknown;
  sourceYaml: string;
}

export interface ConversationHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export interface TurnLoadResult {
  product: Product;
  tools: ToolRecord[];
  procedures: ProcedureCandidate[];
  history: ConversationHistoryEntry[];
}

export async function loadTurnContext(
  tx: Transaction,
  productId: string,
  conversationId: string,
  historyLimit = 40,
): Promise<TurnLoadResult> {
  const product = await findProduct(tx, productId);
  if (product === null) throw new Error(`product ${productId} is not visible in this transaction`);

  const toolRows = await tx.select().from(tool).where(eq(tool.productId, productId));
  const tools = toolRows
    .filter((row) => row.enabled)
    .map((row) =>
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

  const procedureRows = await tx
    .select()
    .from(procedure)
    .where(and(eq(procedure.productId, productId), eq(procedure.active, true)));

  const procedures: ProcedureCandidate[] = procedureRows.map((row) => {
    const body = row.body as { title?: unknown; when?: unknown };
    return {
      slug: row.slug,
      version: row.version,
      title: typeof body.title === "string" ? body.title : row.slug,
      when: typeof body.when === "string" ? body.when : "",
      body: row.body,
      sourceYaml: row.sourceYaml,
    };
  });

  const messageRows = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq))
    .limit(historyLimit);

  const history: ConversationHistoryEntry[] = [];
  for (const row of messageRows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const content = row.content as { text?: unknown };
    if (typeof content.text !== "string" || content.text.length === 0) continue;
    history.push({ role: row.role, text: content.text });
  }

  return { product, tools, procedures, history };
}
