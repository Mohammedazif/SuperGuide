import type { ExpectOutcome } from "@superguide/contract/public";
import type { RetrievedChunk } from "@superguide/contract/internal";
import type { KnowledgeRetriever, ProcedureMatcher, ProcedureSelection, TaskVerifier } from "./loop.js";

export class NoProcedureMatcher implements ProcedureMatcher {
  match(): Promise<ProcedureSelection | null> {
    return Promise.resolve(null);
  }
}

export class NoKnowledgeRetriever implements KnowledgeRetriever {
  retrieve(): Promise<RetrievedChunk[]> {
    return Promise.resolve([]);
  }
}

export class NoTaskVerifier implements TaskVerifier {
  verify(): Promise<ExpectOutcome | null> {
    return Promise.resolve(null);
  }
}
