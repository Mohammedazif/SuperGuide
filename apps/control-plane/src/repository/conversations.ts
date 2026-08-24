import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  conversationStatusSchema,
  resolutionStateSchema,
  type ConversationStatus,
  type ResolutionState,
} from "@superguide/contract/public";
import type { Transaction } from "../db/client.js";
import { conversation } from "../db/schema.js";

export interface ConversationRow {
  id: string;
  productId: string;
  endUserId: string;
  status: ConversationStatus;
  resolutionState: ResolutionState;
  activeTurnId: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

function toRow(row: typeof conversation.$inferSelect): ConversationRow {
  return {
    id: row.id,
    productId: row.productId,
    endUserId: row.endUserId,
    status: conversationStatusSchema.parse(row.status),
    resolutionState: resolutionStateSchema.parse(row.resolutionState),
    activeTurnId: row.activeTurnId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

export async function createConversation(
  tx: Transaction,
  productId: string,
  endUserId: string,
): Promise<ConversationRow> {
  const inserted = await tx
    .insert(conversation)
    .values({
      productId,
      endUserId,
      status: "open",
      resolutionState: "in_progress",
      nextSeq: 1,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error("conversation insert returned no row");
  return toRow(row);
}

export async function findConversation(
  tx: Transaction,
  conversationId: string,
): Promise<ConversationRow | null> {
  const rows = await tx
    .select()
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

export async function listConversations(
  tx: Transaction,
  productId: string,
  endUserId: string,
): Promise<ConversationRow[]> {
  const rows = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.productId, productId), eq(conversation.endUserId, endUserId)))
    .orderBy(desc(conversation.createdAt))
    .limit(50);
  return rows.map(toRow);
}

export async function setActiveTurn(
  tx: Transaction,
  conversationId: string,
  turnId: string | null,
): Promise<void> {
  await tx
    .update(conversation)
    .set({ activeTurnId: turnId })
    .where(eq(conversation.id, conversationId));
}

export async function setResolution(
  tx: Transaction,
  conversationId: string,
  resolutionState: ResolutionState,
  close: boolean,
): Promise<void> {
  await tx
    .update(conversation)
    .set({
      resolutionState,
      ...(close ? { status: "closed" as const, closedAt: new Date() } : {}),
    })
    .where(eq(conversation.id, conversationId));
}

export async function listInFlightConversations(tx: Transaction): Promise<ConversationRow[]> {
  const rows = await tx
    .select()
    .from(conversation)
    .where(isNotNull(conversation.activeTurnId))
    .limit(500);
  return rows.map(toRow);
}
