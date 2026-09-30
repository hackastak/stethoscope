import type { FastifyRequest } from "fastify";

/** A per-IP request budget over a fixed window. Not an env var — the config list is closed (Q33). */
export type RateLimit = {
  max: number;
  windowMs: number;
};

type Bucket = {
  readonly windowStart: number;
  readonly count: number;
};

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * In-process fixed-window limiter keyed by an arbitrary string (the caller's IP).
 * No dependency, no shared state beyond this closure. Expired buckets are dropped lazily on the
 * next check. Bound to 127.0.0.1 the process shares one IP, so this is effectively a process budget.
 */
export function createFixedWindowLimiter(max: number, windowMs: number, now: () => number) {
  const buckets = new Map<string, Bucket>();
  return {
    take(key: string): RateLimitDecision {
      const at = now();
      const expiredBefore = at - windowMs;
      for (const [ip, bucket] of buckets) {
        if (bucket.windowStart <= expiredBefore) buckets.delete(ip);
      }
      const current = buckets.get(key);
      if (!current) {
        buckets.set(key, { windowStart: at, count: 1 });
        return { allowed: true };
      }
      if (current.count >= max) {
        const remainingMs = current.windowStart + windowMs - at;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
      }
      buckets.set(key, { windowStart: current.windowStart, count: current.count + 1 });
      return { allowed: true };
    },
  };
}

export function clientIp(request: FastifyRequest): string {
  return request.ip.length > 0 ? request.ip : "unknown";
}

/** `resource` names the limited route in the message, e.g. "narrative" or "sync". */
export function rateLimitMessage(
  resource: string,
  max: number,
  windowMs: number,
  retryAfterSeconds: number,
): string {
  const windowSeconds = windowMs / 1000;
  return [
    `Too many ${resource} requests from this IP.`,
    `Limit is ${max} per ${windowSeconds} seconds.`,
    `Retry after ${retryAfterSeconds} seconds.`,
  ].join(" ");
}
