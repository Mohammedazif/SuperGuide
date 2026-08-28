import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { expandRouteTemplate, resolveStepAction } from "@superguide/adapters";
import {
  evaluatePredicate,
  paramsHashOf,
  type ActionResult,
  type AdapterCapability,
  type AgentAction,
  type Confirmation,
  type ExpectPredicate,
  type GrantTier,
  type PageDigest,
  type RiskClass,
  type SiteAdapter,
  actionResultSchema,
  pageDigestSchema,
} from "@superguide/contract/anywhere";
import { evaluateAnywherePolicy } from "@superguide/policy";
import type { Environment } from "../../env.js";
import type { QuotaService } from "../quota.js";
import type { TurnStore } from "../store.js";
import { injectionScanSchema, type InjectionScan } from "./classifier.js";
import { envelopeDigest, envelopeObservation, extractPageStrings } from "./provenance.js";
import {
  adapterInvocationSchema,
  askUserInputSchema,
  buildTaskMessage,
  finishInputSchema,
  pageActionInputSchema,
} from "./prompts.js";
import { classifyRisk } from "./risk.js";

export interface TurnInput {
  turnId: string;
  deviceId: string;
  origin: string;
  url: string;
  tier: GrantTier;
  taskText: string;
  digest: PageDigest;
  adapter: SiteAdapter | null;
}

export interface AgentWaits {
  resultTimeoutMs: number;
  confirmTimeoutMs: number;
  pollMs: number;
}

export interface AgentDeps {
  env: Environment;
  pool: pg.Pool;
  store: TurnStore;
  quotas: QuotaService;
  plan(messages: Anthropic.MessageParam[]): Promise<Anthropic.Message>;
  scan(strings: string[]): Promise<InjectionScan>;
  waits?: Partial<AgentWaits>;
}

const DEFAULT_WAITS: AgentWaits = {
  resultTimeoutMs: 120_000,
  confirmTimeoutMs: 300_000,
  pollMs: 250,
};

interface ToolOutcome {
  content: string;
  isError: boolean;
  digest: PageDigest | null;
}

// What the loop has actually seen hold on the page. A completion claim is
// honoured only when nothing is standing failed: no failed predicate, and no
// attempted action that failed, was refused, or went unverified since the last
// clean one.
interface Verification {
  lastVerified: string | null;
  lastFailedPredicate: ExpectPredicate | null;
  lastAttemptFailed: boolean;
  writeConsent: boolean;
}

type TurnEnd = "completed" | "failed" | "needs-input";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TurnAgent {
  private readonly waits: AgentWaits;

  constructor(private readonly deps: AgentDeps) {
    this.waits = { ...DEFAULT_WAITS, ...deps.waits };
  }

  start(input: TurnInput): void {
    void this.run(input)
      .catch(async (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        await this.deps.store.appendTrajectory(input.turnId, "error", { message });
        await this.deps.store.appendEvent(input.turnId, {
          kind: "report",
          outcome: "not-completed",
          detail: "the agent stopped on an internal error; nothing further was done",
          failedPredicate: null,
          lastVerifiedState: null,
        });
        await this.endTurn(input, "failed");
      })
      .catch(() => undefined);
  }

  async run(input: TurnInput): Promise<void> {
    const { store, env } = this.deps;

    const scan = await this.deps
      .scan(extractPageStrings(input.digest))
      .then((verdict) => injectionScanSchema.parse(verdict))
      .catch((): InjectionScan => ({
        suspicious: true,
        findings: ["the injection scan was unavailable; treating the page as suspect"],
      }));
    await store.appendTrajectory(input.turnId, "injection-scan", scan);

    let digest: PageDigest | null = input.digest;
    const verification: Verification = {
      lastVerified: null,
      lastFailedPredicate: null,
      lastAttemptFailed: false,
      writeConsent: false,
    };

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: buildTaskMessage({
          taskText: input.taskText,
          origin: input.origin,
          url: input.url,
          tier: input.tier,
          adapter: input.adapter,
          envelopedDigest: envelopeDigest(input.digest, scan),
        }),
      },
    ];

    for (let step = 0; step < env.SG_STEP_BUDGET; step += 1) {
      const response = await this.deps.plan(messages);
      await store.appendTrajectory(input.turnId, "model-response", {
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        },
      });

      if (response.stop_reason === "refusal") {
        const stopDetails = (response as { stop_details?: { type?: string; category?: string } })
          .stop_details;
        const category =
          stopDetails?.type === "refusal" ? (stopDetails.category ?? null) : null;
        await store.appendTrajectory(input.turnId, "refusal", { source: "model", category });
        await store.appendEvent(input.turnId, {
          kind: "refusal",
          reason: "model_refusal",
          detail:
            category === null
              ? "the model declined this request"
              : `the model declined this request (${category})`,
        });
        await this.endTurn(input, "failed");
        return;
      }

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      if (response.stop_reason === "max_tokens") {
        await store.appendEvent(input.turnId, {
          kind: "report",
          outcome: "not-completed",
          detail: "the model's response was truncated at the token limit; the task did not finish",
          failedPredicate: verification.lastFailedPredicate,
          lastVerifiedState: verification.lastVerified,
        });
        await this.endTurn(input, "failed");
        return;
      }

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          await store.appendEvent(input.turnId, { kind: "assistant-text", text: block.text });
        }
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (toolUses.length === 0) {
        await this.endTurn(input, "needs-input");
        return;
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        if (toolUse.name === "finish") {
          const finish = finishInputSchema.safeParse(toolUse.input);
          if (!finish.success) {
            results.push(invalidInput(toolUse.id, finish.error.message));
            continue;
          }
          // A completion claim is honoured only when no predicate is standing
          // failed; otherwise the report is downgraded to what was verified.
          const honest =
            finish.data.outcome === "completed" &&
            (verification.lastFailedPredicate !== null || verification.lastAttemptFailed)
              ? "not-completed"
              : finish.data.outcome;
          await store.appendTrajectory(input.turnId, "report", {
            outcome: honest,
            claimed: finish.data.outcome,
            detail: finish.data.detail,
          });
          await store.appendEvent(input.turnId, {
            kind: "report",
            outcome: honest,
            detail: finish.data.detail,
            failedPredicate: verification.lastFailedPredicate,
            lastVerifiedState: verification.lastVerified,
          });
          await this.endTurn(input, honest === "completed" ? "completed" : "failed");
          return;
        }

        if (toolUse.name === "ask_user") {
          const ask = askUserInputSchema.safeParse(toolUse.input);
          if (!ask.success) {
            results.push(invalidInput(toolUse.id, ask.error.message));
            continue;
          }
          await store.appendTrajectory(input.turnId, "question", { text: ask.data.question });
          await store.appendEvent(input.turnId, { kind: "question", text: ask.data.question });
          await this.endTurn(input, "needs-input");
          return;
        }

        if (
          toolUse.name === "page_action" ||
          toolUse.name === "adapter_capability" ||
          toolUse.name === "adapter_route"
        ) {
          let outcome: ToolOutcome;
          if (toolUse.name === "page_action") {
            outcome = await this.handlePageAction(input, digest, toolUse, verification);
          } else if (toolUse.name === "adapter_capability") {
            outcome = await this.handleAdapterCapability(input, digest, toolUse, verification);
          } else {
            outcome = await this.handleAdapterRoute(input, toolUse, verification);
          }
          digest = outcome.digest ?? digest;
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          });
          continue;
        }

        results.push(invalidInput(toolUse.id, `unknown tool ${toolUse.name}`));
      }
      messages.push({ role: "user", content: results });
    }

    await store.appendTrajectory(input.turnId, "report", {
      outcome: "not-completed",
      detail: "step budget exhausted",
    });
    await store.appendEvent(input.turnId, {
      kind: "report",
      outcome: "not-completed",
      detail: `the step budget of ${String(env.SG_STEP_BUDGET)} was spent before the task finished`,
      failedPredicate: verification.lastFailedPredicate,
      lastVerifiedState: verification.lastVerified,
    });
    await this.endTurn(input, "failed");
  }

  private async handlePageAction(
    input: TurnInput,
    digest: PageDigest | null,
    toolUse: Anthropic.ToolUseBlock,
    verification: Verification,
  ): Promise<ToolOutcome> {
    const { store } = this.deps;
    const parsed = pageActionInputSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        content: `invalid page_action input: ${parsed.error.message}`,
        isError: true,
        digest: null,
      };
    }
    const { action, expect, summary } = parsed.data;
    const actionId = randomUUID();
    const risk = classifyRisk(action, digest);
    const paramsHash = await paramsHashOf(action);
    await store.appendTrajectory(input.turnId, "action-planned", {
      actionId,
      action,
      risk,
      expect,
      summary,
    });

    let verdict = evaluateAnywherePolicy({
      actionId,
      action,
      paramsHash,
      risk,
      adapterMatched: false,
      siteActivated: true,
      tier: input.tier,
      writeConsent: verification.writeConsent,
      confirmation: null,
    });
    await store.appendTrajectory(input.turnId, "policy-verdict", { actionId, verdict });

    if (verdict.kind === "confirm") {
      await store.appendEvent(input.turnId, {
        kind: "action-request",
        actionId,
        action,
        risk,
        expect,
        paramsHash,
        needsConfirmation: true,
        summary: verdict.summary,
      });
      const confirmation = await this.waitForConfirmation(actionId);
      if (confirmation === null) {
        await store.appendTrajectory(input.turnId, "error", {
          actionId,
          message: "no confirmation decision arrived in time",
        });
        return {
          content: "the person did not decide on the confirmation in time; the action did not run",
          isError: false,
          digest: null,
        };
      }
      verdict = evaluateAnywherePolicy({
        actionId,
        action,
        paramsHash,
        risk,
        adapterMatched: false,
        siteActivated: true,
        tier: input.tier,
        writeConsent: verification.writeConsent,
        confirmation,
      });
      await store.appendTrajectory(input.turnId, "policy-verdict", {
        actionId,
        verdict,
        confirmed: true,
      });
      await this.consumeConfirmation(actionId);
    }

    if (verdict.kind === "refuse") {
      verification.lastAttemptFailed = true;
      await store.appendTrajectory(input.turnId, "refusal", { actionId, reason: verdict.reason });
      await store.appendEvent(input.turnId, {
        kind: "refusal",
        reason: verdict.reason,
        detail: summary,
      });
      return {
        content: `the action was refused (${verdict.reason}) and did not run`,
        isError: false,
        digest: null,
      };
    }

    if (risk !== "read") verification.writeConsent = true;

    const delivered = await this.dispatch(input, action, risk, summary, expect, actionId);
    if (delivered === null) {
      verification.lastAttemptFailed = true;
      return {
        content: "the page returned no result for this action in time",
        isError: true,
        digest: null,
      };
    }

    const fresh = delivered.digest;
    const predicates =
      fresh === null
        ? []
        : expect.map((predicate) => ({
            predicate,
            satisfied: evaluatePredicate(predicate, fresh),
          }));
    const failed = predicates.find((entry) => !entry.satisfied)?.predicate ?? null;
    verification.lastFailedPredicate = failed;
    verification.lastAttemptFailed = delivered.result.status !== "completed" || failed !== null;
    if (delivered.result.status === "completed" && failed === null && predicates.length > 0) {
      verification.lastVerified = summary;
    }
    await store.appendTrajectory(input.turnId, "observation", {
      actionId,
      status: delivered.result.status,
      predicates,
    });
    const pageTurned = fresh !== null && fresh.url !== (digest?.url ?? fresh.url);
    return {
      content: envelopeObservation({
        result: delivered.result,
        predicates,
        ...(pageTurned ? { page: fresh } : {}),
      }),
      isError: false,
      digest: fresh,
    };
  }

  private async handleAdapterCapability(
    input: TurnInput,
    digest: PageDigest | null,
    toolUse: Anthropic.ToolUseBlock,
    verification: Verification,
  ): Promise<ToolOutcome> {
    const { store } = this.deps;
    const parsed = adapterInvocationSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        content: `invalid adapter_capability input: ${parsed.error.message}`,
        isError: true,
        digest: null,
      };
    }
    const adapter = input.adapter;
    const capability = adapter?.capabilities.find((entry) => entry.id === parsed.data.id);
    if (adapter === null || capability === undefined) {
      return {
        content: `no reviewed capability named ${parsed.data.id} exists for this site`,
        isError: true,
        digest: null,
      };
    }
    const params = parsed.data.params;
    const invocationId = randomUUID();
    const paramsHash = await paramsHashOf({ capability: capability.id, params });
    await store.appendTrajectory(input.turnId, "action-planned", {
      actionId: invocationId,
      level: "L1",
      capability: capability.id,
      params,
      risk: capability.risk,
    });

    const representative = representativeAction(capability);
    let verdict = evaluateAnywherePolicy({
      actionId: invocationId,
      action: representative,
      paramsHash,
      risk: capability.risk,
      adapterMatched: true,
      siteActivated: true,
      tier: input.tier,
      writeConsent: verification.writeConsent,
      confirmation: null,
    });
    await store.appendTrajectory(input.turnId, "policy-verdict", {
      actionId: invocationId,
      verdict,
    });

    if (verdict.kind === "confirm") {
      const rendered =
        params.length === 0
          ? ""
          : ` (${params.map((param) => `${param.name}: ${param.value}`).join(", ")})`;
      await store.appendEvent(input.turnId, {
        kind: "action-request",
        actionId: invocationId,
        action: representative,
        risk: capability.risk,
        expect: capability.expect,
        paramsHash,
        needsConfirmation: true,
        summary: `Run ${capability.id}: ${capability.description}${rendered}`,
      });
      const confirmation = await this.waitForConfirmation(invocationId);
      if (confirmation === null) {
        verification.lastAttemptFailed = true;
        await store.appendTrajectory(input.turnId, "error", {
          actionId: invocationId,
          message: "no confirmation decision arrived in time",
        });
        return {
          content:
            "the person did not decide on the confirmation in time; the capability did not run",
          isError: false,
          digest: null,
        };
      }
      verdict = evaluateAnywherePolicy({
        actionId: invocationId,
        action: representative,
        paramsHash,
        risk: capability.risk,
        adapterMatched: true,
        siteActivated: true,
        tier: input.tier,
        writeConsent: verification.writeConsent,
        confirmation,
      });
      await store.appendTrajectory(input.turnId, "policy-verdict", {
        actionId: invocationId,
        verdict,
        confirmed: true,
      });
      await this.consumeConfirmation(invocationId);
    }

    if (verdict.kind === "refuse") {
      verification.lastAttemptFailed = true;
      await store.appendTrajectory(input.turnId, "refusal", {
        actionId: invocationId,
        reason: verdict.reason,
      });
      await store.appendEvent(input.turnId, {
        kind: "refusal",
        reason: verdict.reason,
        detail: `Run ${capability.id}: ${capability.description}`,
      });
      return {
        content: `the capability was refused (${verdict.reason}) and did not run`,
        isError: false,
        digest: null,
      };
    }

    if (capability.risk !== "read") verification.writeConsent = true;

    let current = digest;
    const stepResults: { step: string; status: string }[] = [];
    for (const [index, step] of capability.steps.entries()) {
      if (current === null) {
        verification.lastAttemptFailed = true;
        return {
          content: `the page could not be observed before step ${String(index + 1)} of ${capability.id}`,
          isError: true,
          digest: null,
        };
      }
      const resolved = resolveStepAction(step, params, current);
      if (!resolved.ok) {
        verification.lastAttemptFailed = true;
        await store.appendTrajectory(input.turnId, "error", {
          actionId: invocationId,
          step: index,
          message: resolved.error,
        });
        return {
          content: `step ${String(index + 1)} of ${capability.id} could not run: ${resolved.error}`,
          isError: true,
          digest: current,
        };
      }
      const delivered = await this.dispatch(
        input,
        resolved.value,
        capability.risk,
        `${capability.id} step ${String(index + 1)}: ${step.action}`,
        [],
      );
      if (delivered === null) {
        verification.lastAttemptFailed = true;
        return {
          content: `the page returned no result for step ${String(index + 1)} of ${capability.id}`,
          isError: true,
          digest: current,
        };
      }
      stepResults.push({ step: step.action, status: delivered.result.status });
      if (delivered.result.status !== "completed") {
        verification.lastAttemptFailed = true;
        await store.appendTrajectory(input.turnId, "observation", {
          actionId: invocationId,
          capability: capability.id,
          steps: stepResults,
          halted: delivered.result,
        });
        return {
          content: envelopeObservation({
            capability: capability.id,
            steps: stepResults,
            halted: delivered.result,
          }),
          isError: false,
          digest: delivered.digest,
        };
      }
      if (delivered.digest !== null) {
        current = delivered.digest;
      } else {
        const landing =
          resolved.value.kind === "navigate"
            ? { kind: "url-matches" as const, contains: resolved.value.path }
            : capability.expect[0];
        current = landing === undefined ? null : await this.acquireDigest(input, landing);
      }
    }

    const settled = await this.acquireDigest(
      input,
      capability.expect[0] ?? { kind: "url-matches", contains: "/" },
    );
    const final = settled ?? current;
    if (final === null) {
      verification.lastAttemptFailed = true;
      return {
        content: `${capability.id} ran, but the page could not be re-observed to verify it`,
        isError: true,
        digest: null,
      };
    }
    const predicates = capability.expect.map((predicate) => ({
      predicate,
      satisfied: evaluatePredicate(predicate, final),
    }));
    const failed = predicates.find((entry) => !entry.satisfied)?.predicate ?? null;
    verification.lastFailedPredicate = failed;
    verification.lastAttemptFailed = failed !== null;
    if (failed === null) {
      verification.lastVerified = `${capability.id}: ${capability.description}`;
    }
    await store.appendTrajectory(input.turnId, "observation", {
      actionId: invocationId,
      capability: capability.id,
      steps: stepResults,
      predicates,
    });
    return {
      content: envelopeObservation({
        capability: capability.id,
        steps: stepResults,
        predicates,
        page: final,
      }),
      isError: false,
      digest: final,
    };
  }

  private async handleAdapterRoute(
    input: TurnInput,
    toolUse: Anthropic.ToolUseBlock,
    verification: Verification,
  ): Promise<ToolOutcome> {
    const { store } = this.deps;
    const parsed = adapterInvocationSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        content: `invalid adapter_route input: ${parsed.error.message}`,
        isError: true,
        digest: null,
      };
    }
    const adapter = input.adapter;
    const route = adapter?.routes.find((entry) => entry.id === parsed.data.id);
    if (adapter === null || route === undefined) {
      return {
        content: `no reviewed route named ${parsed.data.id} exists for this site`,
        isError: true,
        digest: null,
      };
    }
    const expanded = expandRouteTemplate(route, parsed.data.params);
    if (!expanded.ok) {
      return { content: expanded.error, isError: true, digest: null };
    }
    const action: AgentAction = { kind: "navigate", path: expanded.value };
    const actionId = randomUUID();
    await store.appendTrajectory(input.turnId, "action-planned", {
      actionId,
      level: "L2",
      route: route.id,
      path: expanded.value,
    });
    const verdict = evaluateAnywherePolicy({
      actionId,
      action,
      paramsHash: await paramsHashOf(action),
      risk: "read",
      adapterMatched: true,
      siteActivated: true,
      tier: input.tier,
      writeConsent: verification.writeConsent,
      confirmation: null,
    });
    await store.appendTrajectory(input.turnId, "policy-verdict", { actionId, verdict });
    if (verdict.kind !== "proceed") {
      verification.lastAttemptFailed = true;
      const reason = verdict.kind === "refuse" ? verdict.reason : "confirmation_mismatch";
      await store.appendTrajectory(input.turnId, "refusal", { actionId, reason });
      await store.appendEvent(input.turnId, {
        kind: "refusal",
        reason,
        detail: `Go to ${route.id}`,
      });
      return {
        content: `the route was refused (${reason}) and did not run`,
        isError: false,
        digest: null,
      };
    }
    const delivered = await this.dispatch(input, action, "read", `Go to ${route.id}`, [], actionId);
    if (delivered === null) {
      verification.lastAttemptFailed = true;
      return {
        content: `the page returned no result for the navigation to ${route.id}`,
        isError: true,
        digest: null,
      };
    }
    const fresh = await this.acquireDigest(input, {
      kind: "url-matches",
      contains: expanded.value,
    });
    if (fresh === null) {
      verification.lastAttemptFailed = true;
      return {
        content: `navigated to ${expanded.value}, but the new page could not be observed`,
        isError: true,
        digest: null,
      };
    }
    verification.lastAttemptFailed = false;
    return {
      content: envelopeObservation({ route: route.id, url: expanded.value, page: fresh }),
      isError: false,
      digest: fresh,
    };
  }

  private async dispatch(
    input: TurnInput,
    action: AgentAction,
    risk: RiskClass,
    summary: string,
    expect: ExpectPredicate[],
    presetActionId?: string,
  ): Promise<{ actionId: string; result: ActionResult; digest: PageDigest | null } | null> {
    const { store } = this.deps;
    const actionId = presetActionId ?? randomUUID();
    await store.appendTrajectory(input.turnId, "action-dispatched", { actionId, action });
    await store.appendEvent(input.turnId, {
      kind: "action-request",
      actionId,
      action,
      risk,
      expect,
      paramsHash: await paramsHashOf(action),
      needsConfirmation: false,
      summary,
    });
    const delivered = await this.waitForActionResult(actionId);
    if (delivered === null) {
      await store.appendTrajectory(input.turnId, "error", {
        actionId,
        message: "no action result arrived in time",
      });
      return null;
    }
    return { actionId, ...delivered };
  }

  private async acquireDigest(
    input: TurnInput,
    predicate: ExpectPredicate,
  ): Promise<PageDigest | null> {
    // A navigation can race the port teardown, losing one dispatched waitFor;
    // a second attempt reaches the freshly injected content script.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const delivered = await this.dispatch(
        input,
        { kind: "waitFor", predicate, timeoutMs: 8000 },
        "read",
        "Observe the page",
        [],
      );
      if (delivered !== null && delivered.digest !== null) return delivered.digest;
    }
    return null;
  }

  private async endTurn(input: TurnInput, end: TurnEnd): Promise<void> {
    const { store, quotas } = this.deps;
    const now = new Date();
    if (end === "completed") {
      await store.finishTurn(input.turnId, "completed", async (client) => {
        await client.query("UPDATE turn SET counted = true WHERE id = $1", [input.turnId]);
        await quotas.recordCompletedTask(input.deviceId, now, client);
      });
      await store.appendEvent(input.turnId, {
        kind: "quota",
        quota: await quotas.deviceQuota(input.deviceId, now),
      });
    } else {
      await store.finishTurn(input.turnId, end === "failed" ? "failed" : "needs-input");
    }
    await store.appendTrajectory(input.turnId, "turn-end", { status: end });
    await store.appendEvent(input.turnId, {
      kind: "turn-end",
      status: end === "needs-input" ? "needs-input" : end,
    });
  }

  private async waitForActionResult(
    actionId: string,
  ): Promise<{ result: ActionResult; digest: PageDigest | null } | null> {
    const deadline = Date.now() + this.waits.resultTimeoutMs;
    for (;;) {
      const rows = await this.deps.pool.query<{ result: unknown; digest: unknown }>(
        "SELECT result, digest FROM action_result WHERE action_id = $1",
        [actionId],
      );
      const row = rows.rows[0];
      if (row !== undefined) {
        const result = actionResultSchema.safeParse(row.result);
        if (!result.success) return null;
        const digest = pageDigestSchema.safeParse(row.digest);
        return { result: result.data, digest: digest.success ? digest.data : null };
      }
      if (Date.now() >= deadline) return null;
      await delay(this.waits.pollMs);
    }
  }

  private async waitForConfirmation(actionId: string): Promise<Confirmation | null> {
    const deadline = Date.now() + this.waits.confirmTimeoutMs;
    for (;;) {
      const rows = await this.deps.pool.query<{ params_hash: string; approved: boolean }>(
        "SELECT params_hash, approved FROM confirmation WHERE action_id = $1 AND consumed = false",
        [actionId],
      );
      const row = rows.rows[0];
      if (row !== undefined) {
        return { actionId, paramsHash: row.params_hash, approved: row.approved };
      }
      if (Date.now() >= deadline) return null;
      await delay(this.waits.pollMs);
    }
  }

  private async consumeConfirmation(actionId: string): Promise<void> {
    await this.deps.pool.query("UPDATE confirmation SET consumed = true WHERE action_id = $1", [
      actionId,
    ]);
  }
}

function invalidInput(
  toolUseId: string,
  detail: string,
): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content: detail, is_error: true };
}

// The policy consumes one action per verdict; a capability is authorised as a unit,
// so its first step stands in. Only the action kind reaches a policy branch, and
// the placeholder target never reaches the page: real targets are resolved per
// step, against the live digest, after the verdict.
function representativeAction(capability: AdapterCapability): AgentAction {
  const step = capability.steps[0];
  const placeholder = { id: "e00000000" };
  if (step === undefined) return { kind: "navigate", path: capability.route };
  switch (step.action) {
    case "navigate":
      return { kind: "navigate", path: step.route };
    case "click":
      return { kind: "click", target: placeholder };
    case "type":
      return { kind: "type", target: placeholder, value: "" };
    case "select":
      return { kind: "select", target: placeholder, optionLabel: "?" };
    case "check":
      return { kind: "check", target: placeholder, checked: step.checked };
    case "waitFor":
      return {
        kind: "waitFor",
        predicate: step.predicate,
        timeoutMs: step.timeoutMs ?? 8000,
      };
    default: {
      const exhausted: never = step;
      throw new Error(`unreachable step ${JSON.stringify(exhausted)}`);
    }
  }
}
