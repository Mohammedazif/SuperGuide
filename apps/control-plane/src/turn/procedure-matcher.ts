import { z } from "zod";
import { loadProcedure, tieBreak, type MatchCandidate } from "@superguide/procedures";
import { MODEL_ROUTING } from "../model/routing.js";
import type { ModelClient } from "../model/client.js";
import type { AppLogger } from "../logging.js";
import type { ProcedureMatcher, ProcedureMatchRequest, ProcedureSelection } from "./loop.js";

const shortlistSchema = z.object({
  matches: z
    .array(
      z.object({
        id: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(5),
});

const SHORTLIST_SYSTEM =
  "You are shortlisting which of a support team's written procedures could apply to a request. " +
  "Judge only from each procedure's when clause. Return every procedure that could plausibly apply, " +
  "with a confidence between 0 and 1. Return an empty list when none fit. You are not choosing the " +
  "procedure and you are not deciding what is permitted; a deterministic step does that afterwards.";

export class ModelProcedureMatcher implements ProcedureMatcher {
  readonly #client: ModelClient;
  readonly #logger: AppLogger;

  constructor(client: ModelClient, logger: AppLogger) {
    this.#client = client;
    this.#logger = logger;
  }

  async match(request: ProcedureMatchRequest): Promise<ProcedureSelection | null> {
    if (request.candidates.length === 0) return null;

    const loaded = new Map<string, ReturnType<typeof loadProcedure>>();
    const candidates: MatchCandidate[] = [];

    for (const candidate of request.candidates) {
      const result = loadProcedure(candidate.sourceYaml);
      loaded.set(candidate.slug, result);
      if (!result.ok) {
        this.#logger.error(
          { slug: candidate.slug, issues: result.issues },
          "an active procedure failed to load and was not offered",
        );
        continue;
      }
      candidates.push({
        slug: candidate.slug,
        version: candidate.version,
        title: candidate.title,
        when: candidate.when,
        preconditions: result.procedure.preconditions,
      });
    }

    if (candidates.length === 0) return null;

    const catalogue = candidates
      .map((candidate) => `- id: ${candidate.slug}\n  when: ${candidate.when}`)
      .join("\n");

    let shortlist: z.infer<typeof shortlistSchema>;
    try {
      shortlist = await this.#client.classify({
        model: MODEL_ROUTING.procedureShortlist.model,
        effort: MODEL_ROUTING.procedureShortlist.effort,
        system: SHORTLIST_SYSTEM,
        prompt: `Procedures:\n${catalogue}\n\nRequest:\n${request.userMessage}`,
        schema: shortlistSchema,
        signal: request.signal,
      });
    } catch (error) {
      this.#logger.warn({ err: error }, "the procedure shortlist could not be produced");
      return null;
    }

    const decision = tieBreak({
      candidates,
      shortlist: shortlist.matches.map((entry) => ({
        slug: entry.id,
        confidence: entry.confidence,
      })),
      subject: {
        tier: request.identity.tier,
        role: typeof request.identity.claims["role"] === "string"
          ? request.identity.claims["role"]
          : null,
        scopes: request.identity.scopes,
      },
    });

    if (decision === null) return null;

    const result = loaded.get(decision.slug);
    if (result === undefined || !result.ok) return null;
    const document = result.procedure.document;

    return {
      slug: document.id,
      version: document.version,
      title: document.title,
      body: result.procedure.sourceYaml,
      policy: {
        never: document.policy.never,
        confirm: document.policy.confirm,
        escalateIf: document.policy.escalate_if,
      },
      requiredScopes: document.required_scopes,
      successPredicates: document.success,
    };
  }
}
