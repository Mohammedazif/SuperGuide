import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "../../apps/control-plane/src/model/client.js";
import { buildCachedPrefix } from "../../apps/control-plane/src/model/prompt.js";
import { MODEL_ROUTING } from "../../apps/control-plane/src/model/routing.js";
import type { CompiledTool } from "../../apps/control-plane/src/tools/compiled.js";
import { LIVE_MODEL_REASON, liveApiKey } from "../helpers/live.js";

const apiKey = liveApiKey();

function padding(index: number): string {
  return `Reference note ${String(index)}: ${"the account holder is responsible for keeping billing details current. ".repeat(20)}`;
}

const tools: CompiledTool[] = Array.from({ length: 8 }, (_, index) => ({
  name: `api_operation_${String(index).padStart(2, "0")}`,
  description: padding(index),
  inputSchema: {
    type: "object",
    properties: { intent: { type: "string" }, accountId: { type: "string" } },
    required: ["intent", "accountId"],
    additionalProperties: false,
  },
  risk: "read",
  ladderLevel: "L1",
  timeoutMs: 20_000,
  expectTemplate: [{ kind: "http_status", in: [200] }],
  source: {
    kind: "api",
    operationId: `operation_${String(index)}`,
    method: "GET",
    path: `/api/v1/operation/${String(index)}`,
    pathParams: [],
    queryParams: [],
    bodyParams: [],
  },
}));

describe.skipIf(apiKey === null)("live model calls", () => {
  it("reads the prompt cache on the second call of a conversation", async () => {
    if (apiKey === null) throw new Error(LIVE_MODEL_REASON);

    const client = new AnthropicModelClient({ apiKey });
    const prefix = buildCachedPrefix({
      productName: "Northwind Logistics",
      stepBudget: 12,
      groundedActionsEnabled: false,
      procedure: {
        slug: "update_billing_address",
        version: 1,
        title: "Update the billing address",
        body: padding(99),
      },
      tools,
    });

    const controller = new AbortController();

    const first = await client.generate({
      model: MODEL_ROUTING.planning.model,
      effort: "low",
      system: prefix.system,
      tools: prefix.tools,
      messages: [{ role: "user", content: "Say the single word: ready." }],
      signal: controller.signal,
    });

    const second = await client.generate({
      model: MODEL_ROUTING.planning.model,
      effort: "low",
      system: prefix.system,
      tools: prefix.tools,
      messages: [
        { role: "user", content: "Say the single word: ready." },
        { role: "assistant", content: first.message.content },
        { role: "user", content: "Say the single word: again." },
      ],
      signal: controller.signal,
    });

    expect(first.usage.inputTokens + first.usage.cacheCreationTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  }, 180_000);
});

describe.runIf(apiKey === null)("live model calls", () => {
  it.skip(`skipped: ${LIVE_MODEL_REASON}`, () => undefined);
});
