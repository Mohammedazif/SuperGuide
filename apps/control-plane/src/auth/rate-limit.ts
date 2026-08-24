export interface RateLimitRule {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  readonly #rule: RateLimitRule;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;

  constructor(rule: RateLimitRule, options: { now?: () => number; maxKeys?: number } = {}) {
    this.#rule = rule;
    this.#now = options.now ?? (() => Date.now());
    this.#maxKeys = options.maxKeys ?? 50_000;
  }

  take(key: string, cost = 1): RateLimitDecision {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#rule.capacity, updatedAt: now };

    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(
      this.#rule.capacity,
      bucket.tokens + elapsedSeconds * this.#rule.refillPerSecond,
    );
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      this.#buckets.set(key, bucket);
      const deficit = cost - bucket.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.#rule.refillPerSecond)),
      };
    }

    bucket.tokens -= cost;
    this.#buckets.set(key, bucket);

    if (this.#buckets.size > this.#maxKeys) this.#evictOldest();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.updatedAt < oldestAt) {
        oldestAt = bucket.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.#buckets.delete(oldestKey);
  }
}

export interface RateLimiters {
  session: TokenBucketLimiter;
  chat: TokenBucketLimiter;
  toolResult: TokenBucketLimiter;
}

export function createRateLimiters(now?: () => number): RateLimiters {
  const options = now === undefined ? {} : { now };
  return {
    session: new TokenBucketLimiter({ capacity: 20, refillPerSecond: 0.5 }, options),
    chat: new TokenBucketLimiter({ capacity: 12, refillPerSecond: 0.2 }, options),
    toolResult: new TokenBucketLimiter({ capacity: 120, refillPerSecond: 4 }, options),
  };
}
