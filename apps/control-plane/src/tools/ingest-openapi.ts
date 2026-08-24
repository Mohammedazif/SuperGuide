import { z } from "zod";
import type { ExpectPredicate } from "@superguide/contract/public";
import type { HttpMethod, ToolRecord } from "@superguide/contract/internal";
import { riskForOperation } from "./risk.js";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

const parameterSchema = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "header", "cookie"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});

const operationSchema = z.object({
  operationId: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  parameters: z.array(parameterSchema).optional(),
  requestBody: z
    .object({
      required: z.boolean().optional(),
      content: z.record(
        z.string(),
        z.object({ schema: z.record(z.string(), z.unknown()).optional() }),
      ),
    })
    .optional(),
  responses: z.record(z.string(), z.unknown()).optional(),
});

const documentSchema = z.object({
  openapi: z.string(),
  info: z.object({ title: z.string(), version: z.string() }).optional(),
  servers: z.array(z.object({ url: z.string() })).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export interface IngestedTool {
  record: Omit<ToolRecord, "id" | "productId">;
}

export type IngestOutcome =
  | { ok: true; tools: IngestedTool[]; serverUrl: string | null; skipped: string[] }
  | { ok: false; reason: string };

function successStatuses(responses: Record<string, unknown> | undefined): number[] {
  if (responses === undefined) return [200, 201, 204];
  const codes = Object.keys(responses)
    .map((code) => Number(code))
    .filter((code) => Number.isInteger(code) && code >= 200 && code < 300);
  return codes.length > 0 ? codes : [200, 201, 204];
}

function bodyProperties(
  operation: z.infer<typeof operationSchema>,
): { properties: Record<string, unknown>; required: string[] } {
  const json = operation.requestBody?.content["application/json"];
  const schema = json?.schema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  return { properties: schema?.properties ?? {}, required: schema?.required ?? [] };
}

export function ingestOpenApi(document: unknown): IngestOutcome {
  const parsed = documentSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, reason: `the document is not a usable OpenAPI description` };
  }

  const tools: IngestedTool[] = [];
  const skipped: string[] = [];

  for (const [path, methods] of Object.entries(parsed.data.paths)) {
    for (const [rawMethod, rawOperation] of Object.entries(methods)) {
      const method = rawMethod.toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) continue;

      const operation = operationSchema.safeParse(rawOperation);
      if (!operation.success) {
        skipped.push(`${method} ${path}: no usable operationId or parameters`);
        continue;
      }

      const parameters = operation.data.parameters ?? [];
      const pathParams = parameters.filter((p) => p.in === "path").map((p) => p.name);
      const queryParams = parameters.filter((p) => p.in === "query").map((p) => p.name);

      const body = bodyProperties(operation.data);
      const bodyParams = Object.keys(body.properties);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const parameter of parameters) {
        if (parameter.in !== "path" && parameter.in !== "query") continue;
        properties[parameter.name] = {
          ...(parameter.schema ?? { type: "string" }),
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        };
        if (parameter.required === true) required.push(parameter.name);
      }
      for (const [name, schema] of Object.entries(body.properties)) {
        properties[name] = schema;
      }
      required.push(...body.required);

      const expectTemplate: ExpectPredicate[] = [
        { kind: "http_status", in: successStatuses(operation.data.responses) },
      ];

      tools.push({
        record: {
          name: `api_${operation.data.operationId}`,
          kind: "api",
          riskClass: riskForOperation(method, path, operation.data.operationId),
          definition: {
            kind: "api",
            operationId: operation.data.operationId,
            method,
            path,
            description:
              operation.data.summary ??
              operation.data.description ??
              `${method} ${path}`,
            parameterSchema: { properties, required: [...new Set(required)] },
            pathParams,
            queryParams,
            bodyParams,
          },
          expectTemplate,
          enabled: false,
        },
      });
    }
  }

  const serverUrl = parsed.data.servers?.[0]?.url ?? null;
  return { ok: true, tools, serverUrl, skipped };
}
