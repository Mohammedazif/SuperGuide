import { createHash } from "node:crypto";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ladderLevelForActionType,
  type AgentAction,
  type ExpectOutcome,
  type Identity,
  type PageDigest,
  type PolicyVerdict,
} from "@superguide/contract/public";
import type { RetrievedChunk, StepResult } from "@superguide/contract/internal";
import { DEFAULT_PRODUCT_POLICY, evaluatePolicy, type ProcedurePolicy } from "@superguide/policy";
import type { Environment } from "../env.js";
import type { AppLogger } from "../logging.js";
import { withProduct, type Database } from "../db/client.js";
import type { EphemeralBus } from "../events/ephemeral.js";
import type { PendingCalls } from "./pending-calls.js";
import type { ConfirmationRegistry } from "./confirmations.js";
import { appendMessage, appendStep } from "../repository/journal.js";
import { setResolution } from "../repository/conversations.js";
import { loadTurnContext, type ProcedureCandidate } from "./context.js";
import { compileTools } from "../tools/compile.js";
import type { CompiledTool } from "../tools/compiled.js";
import { buildCachedPrefix, knowledgeEnvelopes, renderDigest, renderProvenanceEnvelope } from "../model/prompt.js";
import { stableStringify } from "../model/stable-json.js";
import { planningChoice } from "../model/routing.js";
import type { ModelClient } from "../model/client.js";
import { plan } from "./planner.js";
import { createLadder } from "../ladder/index.js";
import type { ExecutionResult } from "../ladder/types.js";
import { evaluateWithRules } from "../expect/evaluate.js";
import { redact } from "../secrets/redact.js";
import { createRequestSigner, type RequestSigner } from "../secrets/credentials.js";
import { assertCredentialPermitted } from "../secrets/forwarding-guard.js";
import { loadProductSecret } from "../repository/product-secrets.js";
import type { TurnExecutionContext, TurnExecutionOutcome } from "./runner.js";
import { TurnFailure, describeError } from "../errors.js";
import type { EscalationReason } from "@superguide/contract/internal";

const CONFIRMATION_TIMEOUT_MS = 120_000;

export interface ProcedureSelection {
  slug: string;
  version: number;
  title: string;
  body: string;
  policy: ProcedurePolicy;
  requiredScopes: string[];
  successPredicates: unknown[];
}

export interface ProcedureMatchRequest {
  candidates: readonly ProcedureCandidate[];
  userMessage: string;
  identity: Identity;
  signal: AbortSignal;
}

export interface ProcedureMatcher {
  match(request: ProcedureMatchRequest): Promise<ProcedureSelection | null>;
}

export interface KnowledgeRetriever {
  retrieve(productId: string, query: string, signal: AbortSignal): Promise<RetrievedChunk[]>;
}

export interface TaskVerificationContext {
  productId: string;
  signer: RequestSigner;
  apiBaseUrl: string | null;
  tools: readonly CompiledTool[];
  parameters: Record<string, unknown>;
  identity: Identity;
  signal: AbortSignal;
}

export interface TaskVerifier {
  verify(
    selection: ProcedureSelection,
    context: TaskVerificationContext,
  ): Promise<ExpectOutcome | null>;
}

export interface EscalationContext {
  productId: string;
  conversationId: string;
  turnId: string;
  reason: EscalationReason;
  detail: string;
  identity: Identity;
}

export interface EscalationSink {
  publish(context: EscalationContext): Promise<void>;
}

export interface LoopDependencies {
  env: Environment;
  logger: AppLogger;
  db: Database;
  ephemeral: EphemeralBus;
  pendingCalls: PendingCalls;
  confirmations: ConfirmationRegistry;
  modelClient: ModelClient;
  procedureMatcher: ProcedureMatcher;
  knowledgeRetriever: KnowledgeRetriever;
  taskVerifier: TaskVerifier;
  escalationSink: EscalationSink;
  fetchImplementation?: typeof fetch;
}

export function hashActionParameters(action: AgentAction): string {
  const { toolCallId: _toolCallId, intent: _intent, ...rest } = action;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

const jsonValueSchema = z.json();

function asJsonValue(value: unknown): z.infer<typeof jsonValueSchema> {
  const parsed = jsonValueSchema.safeParse(value ?? null);
  return parsed.success ? parsed.data : { unrepresentable: String(value) };
}

function toStepResult(result: ExecutionResult): StepResult {
  if (result.status === "ok") {
    return {
      status: "ok",
      data: asJsonValue(result.data),
      httpStatus: result.httpStatus,
      url: result.url,
    };
  }
  return {
    status: "failed",
    code: result.code ?? "unknown",
    message: result.message ?? "the step failed without a message",
    httpStatus: result.httpStatus,
    url: result.url,
  };
}

interface StepRecordInput {
  productId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  action: AgentAction;
  verdict: PolicyVerdict;
  result: StepResult;
  expectOutcome: ExpectOutcome;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  secretValues: readonly string[];
  allowedFieldNames: readonly string[];
}

async function recordStep(deps: LoopDependencies, input: StepRecordInput): Promise<void> {
  const redaction = {
    secretValues: input.secretValues,
    allowedFieldNames: input.allowedFieldNames,
  };

  const step = await withProduct(deps.db, input.productId, (tx) =>
    appendStep(tx, {
      conversationId: input.conversationId,
      productId: input.productId,
      turnId: input.turnId,
      ladderLevel: ladderLevelForActionType(input.action.type),
      action: redact(input.action, redaction) as AgentAction,
      policyVerdict: input.verdict,
      result: redact(input.result, redaction) as StepResult,
      expectOutcome: input.expectOutcome,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      latencyMs: input.latencyMs,
      requestId: input.requestId,
    }),
  );

  deps.logger.info(
    {
      requestId: input.requestId,
      turnId: input.turnId,
      seq: step.seq,
      action: input.action.type,
      decision: input.verdict.decision,
      satisfied: input.expectOutcome.satisfied,
      model: input.model,
      cacheReadTokens: input.cacheReadTokens,
      latencyMs: input.latencyMs,
    },
    "step recorded",
  );
}

async function say(
  deps: LoopDependencies,
  productId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  await withProduct(deps.db, productId, (tx) =>
    appendMessage(tx, { conversationId, productId, role: "assistant", text }),
  );
}

function escalationText(reason: string, detail: string): string {
  return [
    "I could not finish this myself, so I have handed it to a person with everything I tried.",
    detail,
    `Reason: ${reason}.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export async function runTurn(
  deps: LoopDependencies,
  context: TurnExecutionContext,
): Promise<TurnExecutionOutcome> {
  const loaded = await withProduct(deps.db, context.productId, (tx) =>
    loadTurnContext(tx, context.productId, context.conversationId),
  );
  const secret = await withProduct(deps.db, context.productId, (tx) =>
    loadProductSecret(tx, context.productId),
  );

  const signer = createRequestSigner(
    Buffer.from(deps.env.SG_SECRET_ENCRYPTION_KEY, "base64"),
    secret,
  );

  // Untrusted page or knowledge content is always in this turn's context, so the guard refuses
  // any credential that is not the product's own service account.
  assertCredentialPermitted("product_service_account", true);
  const secretValues = signer.secretValues();
  const allowedFieldNames = loaded.product.redactionAllowlist.fieldNames;

  const groundedActionsEnabled =
    deps.env.SG_ENABLE_GROUNDED_ACTIONS && loaded.product.groundedActionsEnabled;

  const selection = await deps.procedureMatcher.match({
    candidates: loaded.procedures,
    userMessage: context.userMessage,
    identity: context.identity,
    signal: context.signal,
  });
  const knowledge = await deps.knowledgeRetriever.retrieve(
    context.productId,
    context.userMessage,
    context.signal,
  );

  const compiled = compileTools({
    product: loaded.product,
    tools: loaded.tools,
    groundedActionsEnabled,
  });
  const toolsByName = new Map<string, CompiledTool>(compiled.map((tool) => [tool.name, tool]));

  const prefix = buildCachedPrefix({
    productName: loaded.product.name,
    stepBudget: deps.env.SG_STEP_BUDGET,
    groundedActionsEnabled,
    procedure:
      selection === null
        ? null
        : {
            slug: selection.slug,
            version: selection.version,
            title: selection.title,
            body: selection.body,
          },
    tools: compiled,
  });

  const ladder = createLadder({
    apiBaseUrl: loaded.product.apiBaseUrl,
    signer,
    ephemeral: deps.ephemeral,
    pendingCalls: deps.pendingCalls,
    groundedActionsEnabled,
    ...(deps.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: deps.fetchImplementation }),
  });

  const messages: Anthropic.MessageParam[] = [];
  for (const entry of loaded.history.slice(0, -1)) {
    messages.push({ role: entry.role, content: entry.text });
  }

  const openingBlocks: string[] = [];
  for (const envelope of knowledgeEnvelopes(knowledge)) {
    openingBlocks.push(renderProvenanceEnvelope(envelope));
  }
  openingBlocks.push(
    renderProvenanceEnvelope({
      source: "page_content",
      reference: context.url,
      content: renderDigest(context.digest),
    }),
  );
  openingBlocks.push(`The person says:\n${context.userMessage}`);
  messages.push({ role: "user", content: openingBlocks.join("\n\n") });

  const identity: Identity = context.identity;

  const announceEscalation = async (reason: EscalationReason, detail: string): Promise<void> => {
    deps.ephemeral.publish(context.conversationId, {
      event: "escalation.created",
      turnId: context.turnId,
      conversationId: context.conversationId,
      reason,
      userMessage: detail,
      referenceUrl: `${deps.env.SG_PUBLIC_ORIGIN}/internal/conversations/${context.conversationId}?productId=${context.productId}`,
    });

    try {
      await deps.escalationSink.publish({
        productId: context.productId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        reason,
        detail,
        identity,
      });
    } catch (error) {
      deps.logger.error({ err: error }, "an escalation could not be handed over");
    }
  };

  let observation: PageDigest | null = context.digest;
  let previousStepFailed = false;
  let lastActionParameters: Record<string, unknown> = {};
  const signals: string[] = [];

  for (let stepIndex = 0; stepIndex < deps.env.SG_STEP_BUDGET; stepIndex += 1) {
    if (context.signal.aborted) {
      const stopped = "This was stopped before it finished. Nothing further was attempted.";
      await say(deps, context.productId, context.conversationId, stopped);
      return { resolutionState: "cancelled", summary: stopped, closeConversation: true };
    }

    const planned = await plan({
      client: deps.modelClient,
      prefix,
      messages,
      choice: planningChoice(previousStepFailed),
      toolsByName,
      identity,
      signal: context.signal,
      onTextDelta: (text) => {
        deps.ephemeral.publish(context.conversationId, {
          event: "message.delta",
          turnId: context.turnId,
          text,
        });
      },
    });

    messages.push(planned.assistantTurn);

    if (planned.outcome.kind === "no_action") {
      await say(deps, context.productId, context.conversationId, planned.outcome.text);
      return {
        resolutionState: "in_progress",
        summary: planned.outcome.text,
        closeConversation: false,
      };
    }

    if (planned.outcome.kind === "complete") {
      const verified =
        selection === null
          ? null
          : await deps.taskVerifier.verify(selection, {
              productId: context.productId,
              signer,
              apiBaseUrl: loaded.product.apiBaseUrl,
              tools: compiled,
              parameters: lastActionParameters,
              identity,
              signal: context.signal,
            });

      if (verified !== null && !verified.satisfied) {
        const detail = `I checked afterwards and could not confirm the change: ${verified.detail}`;
        await say(
          deps,
          context.productId,
          context.conversationId,
          escalationText("the final check did not confirm the change", detail),
        );
        await announceEscalation("expect_unsatisfied", detail);
        return {
          resolutionState: "escalated",
          summary: detail,
          closeConversation: true,
        };
      }

      await say(deps, context.productId, context.conversationId, planned.outcome.summary);
      return {
        resolutionState: planned.outcome.resolutionState,
        summary: planned.outcome.summary,
        closeConversation: true,
      };
    }

    const { action, tool } = planned.outcome;
    if (action.type === "call_api" || action.type === "invoke_capability") {
      lastActionParameters = { ...lastActionParameters, ...action.arguments };
    }

    const verdict = evaluatePolicy({
      action,
      toolName: tool.name,
      compiledToolNames: compiled.map((entry) => entry.name),
      requiredScopes: selection?.requiredScopes ?? [],
      procedure: selection?.policy ?? null,
      identity: { tier: identity.tier, scopes: identity.scopes },
      productPolicy: DEFAULT_PRODUCT_POLICY,
      signals,
    });

    if (verdict.decision === "block") {
      await recordStep(deps, {
        productId: context.productId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        requestId: context.requestId,
        action,
        verdict,
        result: {
          status: "not_executed",
          code: verdict.reason,
          message: "policy refused this action before it ran",
        },
        expectOutcome: {
          satisfied: false,
          evaluatedBy: "rules",
          detail: `policy blocked this action: ${verdict.reason}`,
        },
        model: planned.model,
        inputTokens: planned.usage.inputTokens,
        outputTokens: planned.usage.outputTokens,
        cacheReadTokens: planned.usage.cacheReadTokens,
        latencyMs: planned.latencyMs,
        secretValues,
        allowedFieldNames,
      });

      const detail = "The next step it wanted to take is not permitted for this product.";
      await say(
        deps,
        context.productId,
        context.conversationId,
        escalationText(verdict.reason, detail),
      );
      await announceEscalation("policy_block", detail);
      return { resolutionState: "escalated", summary: detail, closeConversation: true };
    }

    if (action.type === "ask_user") {
      await recordStep(deps, {
        productId: context.productId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        requestId: context.requestId,
        action,
        verdict,
        result: { status: "ok", data: { asked: true }, httpStatus: null, url: null },
        expectOutcome: {
          satisfied: true,
          evaluatedBy: "rules",
          detail: "the question was put to the person",
        },
        model: planned.model,
        inputTokens: planned.usage.inputTokens,
        outputTokens: planned.usage.outputTokens,
        cacheReadTokens: planned.usage.cacheReadTokens,
        latencyMs: planned.latencyMs,
        secretValues,
        allowedFieldNames,
      });

      await say(deps, context.productId, context.conversationId, action.question);
      return {
        resolutionState: "in_progress",
        summary: action.question,
        closeConversation: false,
      };
    }

    if (action.type === "escalate") {
      await recordStep(deps, {
        productId: context.productId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        requestId: context.requestId,
        action,
        verdict,
        result: {
          status: "not_executed",
          code: action.reason,
          message: "the agent handed this to a person",
        },
        expectOutcome: {
          satisfied: false,
          evaluatedBy: "rules",
          detail: "the agent could not finish this itself",
        },
        model: planned.model,
        inputTokens: planned.usage.inputTokens,
        outputTokens: planned.usage.outputTokens,
        cacheReadTokens: planned.usage.cacheReadTokens,
        latencyMs: planned.latencyMs,
        secretValues,
        allowedFieldNames,
      });

      await say(
        deps,
        context.productId,
        context.conversationId,
        escalationText(action.reason, action.summary),
      );
      await announceEscalation("agent_cannot_complete", `${action.reason}: ${action.summary}`);
      return { resolutionState: "escalated", summary: action.summary, closeConversation: true };
    }

    if (verdict.decision === "confirm") {
      const paramsHash = hashActionParameters(action);
      const expiresAt = new Date(Date.now() + CONFIRMATION_TIMEOUT_MS).toISOString();

      const announcement = {
        turnId: context.turnId,
        toolCallId: action.toolCallId,
        paramsHash,
        verdict,
        preview: verdict.preview,
        expiresAt,
      };

      const decisionPromise = deps.confirmations.request(
        action.toolCallId,
        context.conversationId,
        paramsHash,
        CONFIRMATION_TIMEOUT_MS,
        announcement,
      );

      deps.ephemeral.publish(context.conversationId, { event: "action.confirm", ...announcement });

      const decision = await decisionPromise;
      if (decision !== "approved") {
        await recordStep(deps, {
          productId: context.productId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          requestId: context.requestId,
          action,
          verdict,
          result: {
            status: "not_executed",
            code: decision === "denied" ? "confirmation_denied" : "confirmation_timeout",
            message: "the person did not approve this action",
          },
          expectOutcome: {
            satisfied: false,
            evaluatedBy: "rules",
            detail: `the action was not approved: ${decision}`,
          },
          model: planned.model,
          inputTokens: planned.usage.inputTokens,
          outputTokens: planned.usage.outputTokens,
          cacheReadTokens: planned.usage.cacheReadTokens,
          latencyMs: planned.latencyMs,
          secretValues,
          allowedFieldNames,
        });

        const detail =
          decision === "denied"
            ? "You did not approve the step it wanted to take, so nothing was changed."
            : "The confirmation was not answered in time, so nothing was changed.";
        await say(deps, context.productId, context.conversationId, escalationText(decision, detail));
        await announceEscalation(decision === "denied" ? "confirmation_denied" : "confirmation_timeout", detail);
        return { resolutionState: "escalated", summary: detail, closeConversation: true };
      }
    }

    const result = await ladder.execute(action, {
      productId: context.productId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      tool,
      signal: context.signal,
    });

    const rules = evaluateWithRules(action.expect, {
      httpStatus: result.httpStatus,
      body: result.data,
      url: result.url,
      capabilityStatus: result.capabilityStatus,
      digest: result.digest ?? observation,
    });

    const expectOutcome: ExpectOutcome = rules.decided
      ? rules.outcome
      : {
          satisfied: false,
          evaluatedBy: "rules",
          detail: `the checks could not be decided from what came back: ${rules.details.join("; ")}`,
        };

    const stepResult = toStepResult(result);

    await recordStep(deps, {
      productId: context.productId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      requestId: context.requestId,
      action,
      verdict,
      result: stepResult,
      expectOutcome,
      model: planned.model,
      inputTokens: planned.usage.inputTokens,
      outputTokens: planned.usage.outputTokens,
      cacheReadTokens: planned.usage.cacheReadTokens,
      latencyMs: planned.latencyMs,
      secretValues,
      allowedFieldNames,
    });

    deps.ephemeral.publish(context.conversationId, {
      event: "action.result",
      turnId: context.turnId,
      toolCallId: action.toolCallId,
      satisfied: expectOutcome.satisfied,
      detail: expectOutcome.detail,
    });

    if (planned.toolUseId !== null) {
      const payload = redact(
        {
          satisfied: expectOutcome.satisfied,
          check: expectOutcome.detail,
          result: stepResult,
        },
        { secretValues, allowedFieldNames },
      );
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: planned.toolUseId,
        is_error: !expectOutcome.satisfied,
        content: [
          {
            type: "text",
            text: renderProvenanceEnvelope({
              source: "api_response",
              reference: tool.name,
              content: JSON.stringify(payload),
            }),
          },
        ],
      };
      messages.push({ role: "user", content: [toolResultBlock] });
    }

    if (!expectOutcome.satisfied) {
      previousStepFailed = true;
      signals.push(expectOutcome.detail);
      if (result.message !== null) signals.push(result.message);
      observation = result.digest ?? observation;
      continue;
    }

    previousStepFailed = false;
    observation = result.digest ?? observation;
  }

  const detail =
    "This needed more steps than it is allowed to take, so it stopped rather than carrying on blindly.";
  await say(
    deps,
    context.productId,
    context.conversationId,
    escalationText("step_budget_exhausted", detail),
  );
  await announceEscalation("step_budget_exhausted", detail);
  return { resolutionState: "escalated", summary: detail, closeConversation: true };
}

export function createTurnExecutor(deps: LoopDependencies) {
  return async (context: TurnExecutionContext): Promise<TurnExecutionOutcome> => {
    try {
      return await runTurn(deps, context);
    } catch (error) {
      if (error instanceof TurnFailure && error.code === "turn_cancelled") {
        await withProduct(deps.db, context.productId, (tx) =>
          setResolution(tx, context.conversationId, "cancelled", true),
        );
        return {
          resolutionState: "cancelled",
          summary: "This was stopped before it finished.",
          closeConversation: true,
        };
      }
      deps.logger.error({ err: error, turnId: context.turnId }, "the turn could not be run");
      throw new TurnFailure("turn_failed", describeError(error), { cause: error });
    }
  };
}
