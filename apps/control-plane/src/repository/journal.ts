import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  agentActionSchema,
  expectOutcomeSchema,
  ladderLevelSchema,
  messageRoleSchema,
  policyVerdictSchema,
  type DurableMessage,
  type MessageRole,
} from "@superguide/contract/public";
import { stepResultSchema, type TrajectoryStep } from "@superguide/contract/internal";
import { allocateSeq, type Transaction } from "../db/client.js";
import { message, step } from "../db/schema.js";

export interface AppendMessageInput {
  conversationId: string;
  productId: string;
  role: MessageRole;
  text: string;
}

export async function appendMessage(
  tx: Transaction,
  input: AppendMessageInput,
): Promise<DurableMessage> {
  const seq = await allocateSeq(tx, input.conversationId);
  const inserted = await tx
    .insert(message)
    .values({
      conversationId: input.conversationId,
      productId: input.productId,
      role: input.role,
      content: { text: input.text },
      seq,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error("message insert returned no row");
  return {
    id: row.id,
    seq: row.seq,
    role: input.role,
    content: { text: input.text },
    createdAt: row.createdAt.toISOString(),
  };
}

export type AppendStepInput = Omit<TrajectoryStep, "id" | "seq" | "createdAt">;

export async function appendStep(
  tx: Transaction,
  input: AppendStepInput,
): Promise<TrajectoryStep> {
  const seq = await allocateSeq(tx, input.conversationId);
  const inserted = await tx
    .insert(step)
    .values({
      conversationId: input.conversationId,
      productId: input.productId,
      turnId: input.turnId,
      seq,
      ladderLevel: input.ladderLevel,
      action: input.action,
      policyVerdict: input.policyVerdict,
      result: input.result,
      expectOutcome: input.expectOutcome,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      latencyMs: input.latencyMs,
      requestId: input.requestId,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error("step insert returned no row");
  return { ...input, id: row.id, seq: row.seq, createdAt: row.createdAt.toISOString() };
}

export type JournalEntry =
  | { kind: "message"; seq: number; message: DurableMessage }
  | { kind: "step"; seq: number; step: TrajectoryStep };

export async function readJournalSince(
  tx: Transaction,
  conversationId: string,
  afterSeq: number,
  limit = 500,
): Promise<JournalEntry[]> {
  const messageRows = await tx
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), gt(message.seq, afterSeq)))
    .orderBy(asc(message.seq))
    .limit(limit);

  const stepRows = await tx
    .select()
    .from(step)
    .where(and(eq(step.conversationId, conversationId), gt(step.seq, afterSeq)))
    .orderBy(asc(step.seq))
    .limit(limit);

  const entries: JournalEntry[] = [];

  for (const row of messageRows) {
    const content = row.content as { text?: unknown };
    entries.push({
      kind: "message",
      seq: row.seq,
      message: {
        id: row.id,
        seq: row.seq,
        role: messageRoleSchema.parse(row.role),
        content: { text: typeof content.text === "string" ? content.text : "" },
        createdAt: row.createdAt.toISOString(),
      },
    });
  }

  for (const row of stepRows) {
    entries.push({
      kind: "step",
      seq: row.seq,
      step: {
        id: row.id,
        conversationId: row.conversationId,
        productId: row.productId,
        turnId: row.turnId,
        seq: row.seq,
        ladderLevel: ladderLevelSchema.parse(row.ladderLevel),
        action: agentActionSchema.parse(row.action),
        policyVerdict: policyVerdictSchema.parse(row.policyVerdict),
        result: stepResultSchema.parse(row.result),
        expectOutcome: expectOutcomeSchema.parse(row.expectOutcome),
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        latencyMs: row.latencyMs,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      },
    });
  }

  entries.sort((left, right) => left.seq - right.seq);
  return entries.slice(0, limit);
}

export async function highestSeq(tx: Transaction, conversationId: string): Promise<number> {
  const result = await tx.execute<{ seq: string | null }>(
    sql`SELECT max(seq)::text AS seq FROM (
          SELECT seq FROM message WHERE conversation_id = ${conversationId}::uuid
          UNION ALL
          SELECT seq FROM step WHERE conversation_id = ${conversationId}::uuid
        ) AS journal`,
  );
  const value = result.rows[0]?.seq;
  return value === null || value === undefined ? 0 : Number(value);
}
