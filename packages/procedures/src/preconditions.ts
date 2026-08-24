export type Precondition =
  | { kind: "authenticated" }
  | { kind: "verified" }
  | { kind: "role_in"; roles: string[] }
  | { kind: "scope"; scope: string };

export type PreconditionParse =
  | { ok: true; precondition: Precondition }
  | { ok: false; reason: string };

const ROLE_IN = /^user\.role\s+in\s*\[(.+)\]$/i;
const SCOPE = /^user\.scope\s+has\s+(\S+)$/i;

export function parsePrecondition(raw: string): PreconditionParse {
  const text = raw.trim();

  if (/^user\.authenticated$/i.test(text)) return { ok: true, precondition: { kind: "authenticated" } };
  if (/^user\.verified$/i.test(text)) return { ok: true, precondition: { kind: "verified" } };

  const roleMatch = ROLE_IN.exec(text);
  if (roleMatch?.[1] !== undefined) {
    const roles = roleMatch[1]
      .split(",")
      .map((role) => role.trim().replace(/^["']|["']$/g, ""))
      .filter((role) => role.length > 0);
    if (roles.length === 0) return { ok: false, reason: `${text} lists no roles` };
    return { ok: true, precondition: { kind: "role_in", roles } };
  }

  const scopeMatch = SCOPE.exec(text);
  if (scopeMatch?.[1] !== undefined) {
    return { ok: true, precondition: { kind: "scope", scope: scopeMatch[1] } };
  }

  return {
    ok: false,
    reason: `"${text}" is not a precondition this system can check. Use user.authenticated, user.verified, user.role in [a, b], or user.scope has <scope>.`,
  };
}

export interface PreconditionSubject {
  tier: "anonymous" | "unverified" | "verified";
  role: string | null;
  scopes: readonly string[];
}

export function preconditionHolds(
  precondition: Precondition,
  subject: PreconditionSubject,
): boolean {
  switch (precondition.kind) {
    case "authenticated":
      return subject.tier !== "anonymous";
    case "verified":
      return subject.tier === "verified";
    case "role_in":
      return subject.role !== null && precondition.roles.includes(subject.role);
    case "scope":
      return subject.scopes.includes(precondition.scope);
    default: {
      const exhaustive: never = precondition;
      throw new Error(`unhandled precondition: ${JSON.stringify(exhaustive)}`);
    }
  }
}
