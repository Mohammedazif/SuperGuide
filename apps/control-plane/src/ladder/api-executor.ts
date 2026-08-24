import type { AgentAction } from "@superguide/contract/public";
import type { RequestSigner } from "../secrets/credentials.js";
import { failedResult, type ExecutionContext, type ExecutionResult } from "./types.js";

export interface ApiExecutorOptions {
  baseUrl: string;
  signer: RequestSigner;
  fetchImplementation?: typeof fetch;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function buildUrl(
  baseUrl: string,
  path: string,
  pathParams: readonly string[],
  queryParams: readonly string[],
  args: Record<string, unknown>,
): { ok: true; url: URL } | { ok: false; missing: string } {
  let resolved = path;
  for (const parameter of pathParams) {
    const value = args[parameter];
    if (value === undefined || value === null) return { ok: false, missing: parameter };
    resolved = resolved.replace(`{${parameter}}`, encodeURIComponent(scalar(value)));
  }

  const url = new URL(resolved.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const parameter of queryParams) {
    const value = args[parameter];
    if (value !== undefined && value !== null) url.searchParams.set(parameter, scalar(value));
  }
  return { ok: true, url };
}

export async function executeApiCall(
  action: Extract<AgentAction, { type: "call_api" }>,
  context: ExecutionContext,
  options: ApiExecutorOptions,
): Promise<ExecutionResult> {
  const source = context.tool.source;
  if (source.kind !== "api") {
    return failedResult("tool_mismatch", "this tool is not an api operation");
  }

  const built = buildUrl(
    options.baseUrl,
    source.path,
    source.pathParams,
    source.queryParams,
    action.arguments,
  );
  if (!built.ok) {
    return failedResult("missing_path_parameter", `no value was supplied for ${built.missing}`);
  }

  const headers = new Headers({ accept: "application/json" });
  options.signer.applyTo(headers);

  let body: string | undefined;
  if (source.bodyParams.length > 0 && source.method !== "GET" && source.method !== "HEAD") {
    const payload: Record<string, unknown> = {};
    for (const parameter of source.bodyParams) {
      if (Object.hasOwn(action.arguments, parameter)) payload[parameter] = action.arguments[parameter];
    }
    body = JSON.stringify(payload);
    headers.set("content-type", "application/json");
  }

  const perform = options.fetchImplementation ?? fetch;

  try {
    const response = await perform(built.url, {
      method: source.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: context.signal,
    });

    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return {
      status: response.ok ? "ok" : "failed",
      data,
      httpStatus: response.status,
      url: built.url.toString(),
      capabilityStatus: response.ok ? "ok" : "failed",
      digest: null,
      code: response.ok ? null : `http_${String(response.status)}`,
      message: response.ok ? null : `the API replied with status ${String(response.status)}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return failedResult("cancelled", "the turn was cancelled before the call completed");
    }
    return failedResult(
      "api_unreachable",
      `the API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
