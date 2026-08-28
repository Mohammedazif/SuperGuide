import { parse as parseYaml, YAMLParseError } from "yaml";
import { procedureDocumentSchema, type ProcedureDocument } from "./schema.js";
import { parsePrecondition, type Precondition } from "./preconditions.js";

export interface ProcedureIssue {
  path: string;
  message: string;
}

export interface LoadedProcedure {
  document: ProcedureDocument;
  preconditions: Precondition[];
  sourceYaml: string;
}

export type LoadResult =
  | { ok: true; procedure: LoadedProcedure }
  | { ok: false; issues: ProcedureIssue[] };

// Fail closed: an invalid procedure is never activated.
export function loadProcedure(sourceYaml: string): LoadResult {
  let raw: unknown;
  try {
    raw = parseYaml(sourceYaml);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      return { ok: false, issues: [{ path: "", message: `the YAML could not be read: ${error.message}` }] };
    }
    throw error;
  }

  const parsed = procedureDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const preconditions: Precondition[] = [];
  const issues: ProcedureIssue[] = [];

  parsed.data.preconditions.forEach((raw, index) => {
    const outcome = parsePrecondition(raw);
    if (outcome.ok) preconditions.push(outcome.precondition);
    else issues.push({ path: `preconditions.${String(index)}`, message: outcome.reason });
  });

  const operations = new Set<string>();
  parsed.data.steps.forEach((step, index) => {
    const operation = step.prefer_api?.operation;
    if (operation === undefined) return;
    if (operations.has(operation)) {
      issues.push({
        path: `steps.${String(index)}.prefer_api.operation`,
        message: `${operation} appears in more than one step, which makes the order ambiguous`,
      });
    }
    operations.add(operation);
  });

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, procedure: { document: parsed.data, preconditions, sourceYaml } };
}

export function formatIssues(issues: readonly ProcedureIssue[]): string {
  return issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path}: ${issue.message}`))
    .join("\n");
}
