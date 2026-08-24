import { preconditionHolds, type Precondition, type PreconditionSubject } from "./preconditions.js";

export interface MatchCandidate {
  slug: string;
  version: number;
  title: string;
  when: string;
  preconditions: readonly Precondition[];
}

export interface ShortlistEntry {
  slug: string;
  confidence: number;
}

export interface TieBreakInput {
  candidates: readonly MatchCandidate[];
  shortlist: readonly ShortlistEntry[];
  subject: PreconditionSubject;
}

export interface MatchDecision {
  slug: string;
  version: number;
  satisfiedPreconditions: number;
  confidence: number;
}

// The shortlist is a model judgement. Everything after it is deterministic: preconditions
// that hold, then confidence, then version, then slug. The same inputs always give the
// same answer, which is what makes the matcher testable against recorded transcripts.
export function tieBreak(input: TieBreakInput): MatchDecision | null {
  const bySlug = new Map(input.candidates.map((candidate) => [candidate.slug, candidate]));

  const scored: MatchDecision[] = [];
  for (const entry of input.shortlist) {
    const candidate = bySlug.get(entry.slug);
    if (candidate === undefined) continue;

    const holds = candidate.preconditions.filter((precondition) =>
      preconditionHolds(precondition, input.subject),
    );
    if (holds.length < candidate.preconditions.length) continue;

    scored.push({
      slug: candidate.slug,
      version: candidate.version,
      satisfiedPreconditions: holds.length,
      confidence: entry.confidence,
    });
  }

  if (scored.length === 0) return null;

  scored.sort((left, right) => {
    if (right.satisfiedPreconditions !== left.satisfiedPreconditions) {
      return right.satisfiedPreconditions - left.satisfiedPreconditions;
    }
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    if (right.version !== left.version) return right.version - left.version;
    return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0;
  });

  return scored[0] ?? null;
}
