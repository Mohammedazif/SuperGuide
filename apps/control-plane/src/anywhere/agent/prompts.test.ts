import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, SYSTEM_PROMPT, buildPlannerRequest } from "./prompts.js";

function objectNodes(schema: unknown, path = "$"): { path: string; node: Record<string, unknown> }[] {
  if (schema === null || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const found: { path: string; node: Record<string, unknown> }[] = [];
  if (record["type"] === "object") found.push({ path, node: record });
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        found.push(...objectNodes(entry, `${path}.${key}[${String(index)}]`));
      });
    } else if (typeof value === "object" && value !== null) {
      found.push(...objectNodes(value, `${path}.${key}`));
    }
  }
  return found;
}

describe("the planner request prefix", () => {
  it("is byte-identical whatever the conversation contains", () => {
    const first = buildPlannerRequest([{ role: "user", content: "change the billing email" }]);
    const second = buildPlannerRequest([
      { role: "user", content: "an entirely different task" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "with more history" },
    ]);
    const prefixOf = (request: typeof first): string =>
      JSON.stringify({
        model: request.model,
        max_tokens: request.max_tokens,
        system: request.system,
        tools: request.tools,
        thinking: request.thinking,
        output_config: request.output_config,
        betas: request.betas,
        fallbacks: request.fallbacks,
      });
    expect(prefixOf(first)).toBe(prefixOf(second));
  });

  it("keeps the volatile content in messages, after the cache breakpoint", () => {
    const request = buildPlannerRequest([{ role: "user", content: "task text" }]);
    expect(request.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(request.messages).toEqual([{ role: "user", content: "task text" }]);
  });

  it("pins the mandated model parameters", () => {
    const request = buildPlannerRequest([]);
    expect(request.model).toBe("claude-opus-5");
    expect(request.max_tokens).toBe(64_000);
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: "xhigh" });
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
  });

  it("orders the tools deterministically, mirroring the ladder", () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "adapter_capability",
      "adapter_route",
      "page_action",
      "ask_user",
      "finish",
    ]);
  });

  it("declares every tool strict with closed object schemas throughout", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.strict).toBe(true);
      for (const { path, node } of objectNodes(tool.input_schema)) {
        expect(node["additionalProperties"], `${tool.name} ${path}`).toBe(false);
        const properties = Object.keys(node["properties"] as Record<string, unknown>);
        expect(node["required"], `${tool.name} ${path}`).toEqual(properties);
      }
    }
  });
});
