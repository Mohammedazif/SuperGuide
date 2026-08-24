import type { IdentityTier } from "@superguide/contract/public";
import type { Product } from "@superguide/contract/internal";

export interface VerifiedIdentity {
  externalId: string;
  tier: IdentityTier;
  scopes: string[];
  claims: Record<string, unknown>;
}

export type IdentityVerification =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: string };

export interface IdentityVerifier {
  verify(product: Product, token: string): Promise<IdentityVerification>;
}

export class RejectingIdentityVerifier implements IdentityVerifier {
  verify(): Promise<IdentityVerification> {
    return Promise.resolve({ ok: false, reason: "identity_verification_not_configured" });
  }
}
