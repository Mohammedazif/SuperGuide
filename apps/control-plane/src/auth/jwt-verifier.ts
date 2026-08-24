import {
  createRemoteJWKSet,
  importSPKI,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { IdentityTier } from "@superguide/contract/public";
import type { JwtAlgorithm, Product } from "@superguide/contract/internal";
import type { AppLogger } from "../logging.js";
import type { IdentityVerification, IdentityVerifier } from "./identity-verifier.js";

export const REJECTED_JWT_ALGORITHMS = ["none", "HS256", "HS384", "HS512"] as const;

const CLOCK_TOLERANCE_SECONDS = 60;
const JWKS_CACHE_TTL_MS = 10 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;

export interface PublicKeySource {
  jwksUrl: string | null;
  spki: string | null;
}

export interface JwksResolverOptions {
  cacheTtlMs?: number;
  cooldownMs?: number;
}

interface CachedResolver {
  resolve: JWTVerifyGetKey;
  createdAt: number;
}

export class AsymmetricIdentityVerifier implements IdentityVerifier {
  readonly #logger: AppLogger;
  readonly #now: () => number;
  readonly #cacheTtlMs: number;
  readonly #cooldownMs: number;
  readonly #resolvers = new Map<string, CachedResolver>();
  readonly #keyFor: (product: Product) => Promise<PublicKeySource>;

  constructor(options: {
    logger: AppLogger;
    keyFor: (product: Product) => Promise<PublicKeySource>;
    now?: () => number;
    jwks?: JwksResolverOptions;
  }) {
    this.#logger = options.logger;
    this.#keyFor = options.keyFor;
    this.#now = options.now ?? (() => Date.now());
    this.#cacheTtlMs = options.jwks?.cacheTtlMs ?? JWKS_CACHE_TTL_MS;
    this.#cooldownMs = options.jwks?.cooldownMs ?? JWKS_COOLDOWN_MS;
  }

  async verify(product: Product, token: string): Promise<IdentityVerification> {
    const algorithms = this.#configuredAlgorithms(product);
    if (algorithms.length === 0) {
      return { ok: false, reason: "no_asymmetric_algorithm_configured" };
    }
    if (product.jwtIssuer === null || product.jwtAudience === null) {
      return { ok: false, reason: "issuer_or_audience_not_configured" };
    }

    let resolve: JWTVerifyGetKey;
    try {
      resolve = await this.#resolverFor(product);
    } catch (error) {
      this.#logger.warn({ err: error, productId: product.id }, "public key material unavailable");
      return { ok: false, reason: "key_material_unavailable" };
    }

    let payload: JWTPayload;
    try {
      // The permitted algorithms come from the product's configuration. The token header
      // never selects the algorithm, so a token signed with a symmetric key derived from the
      // public key is rejected before any signature check is attempted.
      const verified = await jwtVerify(token, resolve, {
        algorithms,
        issuer: product.jwtIssuer,
        audience: product.jwtAudience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp", "iss", "aud"],
        currentDate: new Date(this.#now()),
      });
      payload = verified.payload;
    } catch (error) {
      const code = error instanceof Error ? error.name : "unknown";
      this.#logger.info({ productId: product.id, code }, "identity token rejected");
      return { ok: false, reason: "token_rejected" };
    }

    const subject = payload.sub;
    if (typeof subject !== "string" || subject.length === 0) {
      return { ok: false, reason: "token_rejected" };
    }

    const scopes = typeof payload["scope"] === "string" ? payload["scope"].split(" ").filter((s) => s.length > 0) : [];

    const tier: IdentityTier = "verified";
    const claims: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === "iss" || key === "aud" || key === "exp" || key === "iat" || key === "nbf") continue;
      claims[key] = value;
    }

    return { ok: true, identity: { externalId: subject, tier, scopes, claims } };
  }

  #configuredAlgorithms(product: Product): JwtAlgorithm[] {
    return [...product.jwtAlgorithms];
  }

  async #resolverFor(product: Product): Promise<JWTVerifyGetKey> {
    const cached = this.#resolvers.get(product.id);
    if (cached !== undefined && this.#now() - cached.createdAt < this.#cacheTtlMs) {
      return cached.resolve;
    }

    const source = await this.#keyFor(product);

    let resolve: JWTVerifyGetKey;
    if (source.jwksUrl !== null) {
      resolve = createRemoteJWKSet(new URL(source.jwksUrl), {
        cacheMaxAge: this.#cacheTtlMs,
        cooldownDuration: this.#cooldownMs,
      });
    } else if (source.spki !== null) {
      const algorithms = this.#configuredAlgorithms(product);
      const first = algorithms[0];
      if (first === undefined) throw new Error("no algorithm configured for a static key");
      const key = await importSPKI(source.spki, first);
      resolve = () => Promise.resolve(key);
    } else {
      throw new Error("the product has neither a JWKS url nor a stored public key");
    }

    this.#resolvers.set(product.id, { resolve, createdAt: this.#now() });
    return resolve;
  }
}
