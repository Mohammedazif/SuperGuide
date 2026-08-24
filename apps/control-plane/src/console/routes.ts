import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from "fastify";

import { formatIssues, loadProcedure } from "@superguide/procedures";
import {
  publishProcedureRequestSchema,
  type ProcedureRecord,
  type TrajectoryStep,
} from "@superguide/contract/internal";
import { withProduct, type Database } from "../db/client.js";
import { procedure, tool } from "../db/schema.js";
import { readJournalSince } from "../repository/journal.js";
import { findConversation } from "../repository/conversations.js";
import { ApiFailure } from "../errors.js";
import { CONSOLE_COOKIE, readCookie, verifyConsoleToken, type ConsoleClaims } from "../auth/console-token.js";
import { renderTrajectory, renderProcedureEditor, renderConsoleShell } from "./views.js";

export interface ConsoleDependencies {
  db: Database;
  sessionKey: Buffer;
  now: () => Date;
}

interface ConsoleRequest {
  headers: Record<string, string | string[] | undefined>;
}

// Generic over the logger so the console mounts on the application instance, which carries a
// concrete logger type of its own.
export type ConsoleHost<Logger extends FastifyBaseLogger = FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger
>;

export function registerConsoleRoutes<Logger extends FastifyBaseLogger>(
  app: ConsoleHost<Logger>,
  deps: ConsoleDependencies,
): void {
  const requireOperator = (request: ConsoleRequest): ConsoleClaims => {
    const raw = request.headers.cookie;
    const token = readCookie(typeof raw === "string" ? raw : undefined, CONSOLE_COOKIE);
    if (token === null) throw new ApiFailure("session_invalid");

    const verification = verifyConsoleToken(
      deps.sessionKey,
      token,
      Math.floor(deps.now().getTime() / 1000),
    );
    if (!verification.ok) {
      throw new ApiFailure(verification.reason === "expired" ? "session_expired" : "session_invalid");
    }
    return verification.claims;
  };

  app.get("/internal", (request, reply) => {
    requireOperator(request);
    return reply.header("content-type", "text/html; charset=utf-8").send(renderConsoleShell());
  });

  app.get<{ Params: { conversationId: string }; Querystring: { productId?: string } }>(
    "/internal/conversations/:conversationId",
    async (request, reply) => {
      requireOperator(request);
      const productId = request.query.productId;
      if (productId === undefined) throw new ApiFailure("payload_invalid");

      const view = await withProduct(deps.db, productId, async (tx) => {
        const conversation = await findConversation(tx, request.params.conversationId);
        if (conversation === null) return null;
        const entries = await readJournalSince(tx, request.params.conversationId, 0, 500);
        return { conversation, entries };
      });

      if (view === null) throw new ApiFailure("conversation_unknown");

      const steps: TrajectoryStep[] = view.entries.flatMap((entry) =>
        entry.kind === "step" ? [entry.step] : [],
      );
      const messages = view.entries.flatMap((entry) =>
        entry.kind === "message" ? [entry.message] : [],
      );

      const accepts = request.headers.accept;
      if (typeof accepts === "string" && accepts.includes("application/json")) {
        return reply.send({ conversation: view.conversation, steps, messages });
      }

      return reply
        .header("content-type", "text/html; charset=utf-8")
        .send(renderTrajectory({ conversation: view.conversation, steps, messages }));
    },
  );

  app.get<{ Querystring: { productId?: string } }>(
    "/internal/procedures",
    async (request, reply) => {
      requireOperator(request);
      const productId = request.query.productId;
      if (productId === undefined) throw new ApiFailure("payload_invalid");

      const rows = await withProduct(deps.db, productId, (tx) =>
        tx
          .select()
          .from(procedure)
          .where(eq(procedure.productId, productId))
          .orderBy(asc(procedure.slug), desc(procedure.version)),
      );

      const records: ProcedureRecord[] = rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        slug: row.slug,
        version: row.version,
        body: row.body as ProcedureRecord["body"],
        sourceYaml: row.sourceYaml,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
      }));

      const accepts = request.headers.accept;
      if (typeof accepts === "string" && accepts.includes("application/json")) {
        return reply.send({ procedures: records });
      }
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .send(renderProcedureEditor(productId, records));
    },
  );

  app.post<{ Querystring: { productId?: string } }>(
    "/internal/procedures",
    async (request, reply) => {
      const operator = requireOperator(request);
      const productId = request.query.productId;
      if (productId === undefined) throw new ApiFailure("payload_invalid");

      const body = publishProcedureRequestSchema.safeParse(request.body);
      if (!body.success) throw new ApiFailure("payload_invalid");

      // An invalid procedure is reported and never activated, so nothing is partly applied.
      const loaded = loadProcedure(body.data.sourceYaml);
      if (!loaded.ok) {
        return reply.status(422).send({
          valid: false,
          issues: loaded.issues,
          detail: formatIssues(loaded.issues),
        });
      }

      if (loaded.procedure.document.id !== body.data.slug) {
        return reply.status(422).send({
          valid: false,
          issues: [{ path: "id", message: "the document id must match the slug being published" }],
        });
      }

      const published = await withProduct(deps.db, productId, async (tx) => {
        const highest = await tx.execute<{ version: number | null }>(
          sql`SELECT max(version) AS version FROM procedure
               WHERE product_id = ${productId}::uuid AND slug = ${body.data.slug}`,
        );
        const nextVersion = (highest.rows[0]?.version ?? 0) + 1;

        await tx
          .update(procedure)
          .set({ active: false })
          .where(and(eq(procedure.productId, productId), eq(procedure.slug, body.data.slug)));

        const inserted = await tx
          .insert(procedure)
          .values({
            productId,
            slug: body.data.slug,
            version: nextVersion,
            body: loaded.procedure.document,
            sourceYaml: body.data.sourceYaml,
            active: true,
            createdBy: operator.operatorEmail,
          })
          .returning();

        return inserted[0];
      });

      if (published === undefined) throw new ApiFailure("internal_error");
      return reply.status(201).send({
        valid: true,
        slug: published.slug,
        version: published.version,
      });
    },
  );

  app.post<{ Params: { toolId: string }; Querystring: { productId?: string } }>(
    "/internal/tools/:toolId/enable",
    async (request, reply) => {
      requireOperator(request);
      const productId = request.query.productId;
      if (productId === undefined) throw new ApiFailure("payload_invalid");

      const body = request.body as { enabled?: unknown };
      const enabled = body.enabled === true;

      const updated = await withProduct(deps.db, productId, (tx) =>
        tx
          .update(tool)
          .set({ enabled })
          .where(and(eq(tool.productId, productId), eq(tool.id, request.params.toolId)))
          .returning(),
      );

      if (updated.length === 0) throw new ApiFailure("not_found");
      return reply.send({ id: request.params.toolId, enabled });
    },
  );
}
