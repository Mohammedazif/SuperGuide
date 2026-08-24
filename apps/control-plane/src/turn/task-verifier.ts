import { successPredicateSchema } from "@superguide/procedures";
import type { ExpectOutcome } from "@superguide/contract/public";
import { evaluateWithRules } from "../expect/evaluate.js";
import { resolveTemplateString } from "../expect/template.js";
import { executeApiCall } from "../ladder/api-executor.js";
import type { CompiledTool } from "../tools/compiled.js";
import type { TaskVerificationContext, TaskVerifier, ProcedureSelection } from "./loop.js";

function findApiTool(tools: readonly CompiledTool[], operationId: string): CompiledTool | null {
  return (
    tools.find(
      (tool) => tool.source.kind === "api" && tool.source.operationId === operationId,
    ) ?? null
  );
}

// Task-level success is checked against API state after the task completes, independently of
// anything a client reported.
export class ApiTaskVerifier implements TaskVerifier {
  async verify(
    selection: ProcedureSelection,
    context: TaskVerificationContext,
  ): Promise<ExpectOutcome | null> {
    if (selection.successPredicates.length === 0) return null;
    if (context.apiBaseUrl === null) {
      return {
        satisfied: false,
        evaluatedBy: "rules",
        detail: "the procedure declares a success check but this product has no API configured",
      };
    }

    const scope = {
      params: context.parameters,
      identity: {
        ...context.identity.claims,
        endUserId: context.identity.endUserId,
        externalId: context.identity.externalId,
      },
    };

    const details: string[] = [];

    for (const raw of selection.successPredicates) {
      const parsed = successPredicateSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          satisfied: false,
          evaluatedBy: "rules",
          detail: "a success check in the procedure could not be read",
        };
      }

      if ("predicate" in parsed.data) {
        details.push("a non-API success check was declared and cannot be verified after the fact");
        return {
          satisfied: false,
          evaluatedBy: "rules",
          detail: details.join("; "),
        };
      }

      const check = parsed.data.api;
      const tool = findApiTool(context.tools, check.operation);
      if (tool === null) {
        return {
          satisfied: false,
          evaluatedBy: "rules",
          detail: `the success check names operation ${check.operation}, which this product does not expose`,
        };
      }

      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(check.params)) {
        args[key] = resolveTemplateString(value, scope);
      }
      for (const [key, value] of Object.entries(context.parameters)) {
        if (!Object.hasOwn(args, key)) args[key] = value;
      }

      const result = await executeApiCall(
        {
          type: "call_api",
          toolCallId: `verify-${check.operation}`,
          intent: "Confirm the task actually landed.",
          expect: [{ kind: "http_status", in: [200] }],
          risk: "read",
          timeoutMs: 20_000,
          tool: tool.name,
          arguments: args,
        },
        {
          productId: context.productId,
          conversationId: "",
          turnId: "",
          tool,
          signal: context.signal,
        },
        { baseUrl: context.apiBaseUrl, signer: context.signer },
      );

      const outcome = evaluateWithRules(
        [
          { kind: "http_status", in: [200] },
          {
            kind: "json_path",
            path: check.json_path,
            ...(check.equals === undefined
              ? {}
              : {
                  equals:
                    typeof check.equals === "string"
                      ? resolveTemplateString(check.equals, scope)
                      : check.equals,
                }),
            ...(check.exists === undefined ? {} : { exists: check.exists }),
          },
        ],
        {
          httpStatus: result.httpStatus,
          body: result.data,
          url: result.url,
          capabilityStatus: result.capabilityStatus,
          digest: null,
        },
      );

      if (!outcome.decided) {
        return {
          satisfied: false,
          evaluatedBy: "rules",
          detail: `the success check could not be decided: ${outcome.details.join("; ")}`,
        };
      }
      if (!outcome.outcome.satisfied) return outcome.outcome;
      details.push(outcome.outcome.detail);
    }

    return { satisfied: true, evaluatedBy: "rules", detail: details.join("; ") };
  }
}
