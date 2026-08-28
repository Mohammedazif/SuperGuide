export type CredentialOrigin = "product_service_account" | "forwarded_end_user_token";

export class ForwardedCredentialRefused extends Error {
  override readonly name = "ForwardedCredentialRefused";
}

// R28: forwarded end-user credentials stay refused until injection posture is evaluated.
export const INJECTION_POSTURE_ADVERSARIALLY_EVALUATED: boolean = false;

export function assertCredentialPermitted(
  origin: CredentialOrigin,
  untrustedContentInContext: boolean,
): void {
  if (origin === "product_service_account") return;
  if (!untrustedContentInContext) return;
  if (INJECTION_POSTURE_ADVERSARIALLY_EVALUATED) return;

  throw new ForwardedCredentialRefused(
    "a forwarded end-user credential may not be held while untrusted page or knowledge content " +
      "is in context, because the injection posture has not passed an adversarial evaluation",
  );
}
