import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { Fact } from "../facts/types.js";
import { httpError, problem, validationError } from "../lib/errors.js";
import { createMemoryNarrativeCache, type NarrativeCache } from "../llm/cache.js";
import { synthesize } from "../llm/narrative.js";
import type { LLMProvider } from "../llm/provider.js";
import {
  formatNarrativeIssues,
  narrativeBodySchema,
  narrativeResponseSchema,
  type NarrativeBody,
  type NarrativeResponse,
} from "../schemas/narrative.js";
import { loadInsights, type InsightsConfig } from "./insights.js";

/** Local demo budget. Not an env var — the config list is closed. Decisions Q33. */
export const NARRATIVE_RATE_LIMIT_MAX = 10;
export const NARRATIVE_RATE_LIMIT_WINDOW_MS = 60_000;

export type NarrativeRateLimit = {
  max: number;
  windowMs: number;
};

export type NarrativeRouteOptions = {
  db: AppDatabase;
  config: InsightsConfig & Pick<Config, "llmModel">;
  provider: LLMProvider;
  /** Shared across requests on this plugin. Defaults to one in-memory cache. */
  cache?: NarrativeCache;
  /** Epoch milliseconds. Same clock as omitted bounds and the rate-limit window. */
  now?: () => number;
  rateLimit?: NarrativeRateLimit;
};

type Bucket = {
  readonly windowStart: number;
  readonly count: number;
};

type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function createFixedWindowLimiter(max: number, windowMs: number, now: () => number) {
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

function clientIp(request: FastifyRequest): string {
  return request.ip.length > 0 ? request.ip : "unknown";
}

function rateLimitMessage(max: number, windowMs: number, retryAfterSeconds: number): string {
  const windowSeconds = windowMs / 1000;
  return [
    "Too many narrative requests from this IP.",
    `Limit is ${max} per ${windowSeconds} seconds.`,
    `Retry after ${retryAfterSeconds} seconds.`,
  ].join(" ");
}

function resolveEvidence(
  ids: readonly string[],
  facts: readonly Fact[],
): NarrativeResponse["evidence"] {
  const values = new Map(facts.map((fact) => [fact.id, fact.value]));
  return ids.map((id) => {
    if (!values.has(id)) {
      throw httpError(500, `Narrative evidence id was not in facts: ${id}`);
    }
    const value = values.get(id);
    return { id, value: value ?? null };
  });
}

/**
 * Grounded narrative for one repo window. Facts come from `loadInsights`, so an unsynced
 * window is the same 404/409. Evidence ids are resolved to those fact values before return.
 * Decisions Q31, Q32, Q33.
 */
export const narrativeRoutes: FastifyPluginAsync<NarrativeRouteOptions> = async (app, options) => {
  const limit = options.rateLimit ?? {
    max: NARRATIVE_RATE_LIMIT_MAX,
    windowMs: NARRATIVE_RATE_LIMIT_WINDOW_MS,
  };
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createMemoryNarrativeCache();
  const limiter = createFixedWindowLimiter(limit.max, limit.windowMs, now);

  app.setValidatorCompiler(({ schema }) => {
    return (data) => {
      if (!(schema instanceof z.ZodType)) return { value: data };
      const parsed = schema.safeParse(data);
      if (!parsed.success) return { error: validationError(formatNarrativeIssues(parsed.error)) };
      return { value: parsed.data };
    };
  });

  app.setSerializerCompiler(({ schema }) => {
    return (data) => {
      const value = schema instanceof z.ZodType ? schema.parse(data) : data;
      return JSON.stringify(value);
    };
  });

  app.post<{ Body: NarrativeBody }>(
    "/narrative",
    {
      schema: {
        body: narrativeBodySchema,
        response: {
          200: narrativeResponseSchema,
        },
      },
      preHandler: async (request, reply) => {
        const decision = limiter.take(clientIp(request));
        if (decision.allowed) return;
        // Sent here, not thrown: a client over the budget is not a server fault, and the
        // error handler would log it at error level.
        reply.header("retry-after", String(decision.retryAfterSeconds));
        return reply
          .status(429)
          .send(
            problem(429, rateLimitMessage(limit.max, limit.windowMs, decision.retryAfterSeconds)),
          );
      },
    },
    async (request): Promise<NarrativeResponse> => {
      const insights = loadInsights(options.db, options.config, request.body, { now });
      const narrative = await synthesize(insights.facts, {
        provider: options.provider,
        cache,
        owner: insights.window.owner,
        repo: insights.window.repo,
        since: insights.window.since,
        until: insights.window.until,
        model: options.config.llmModel,
      });
      return {
        window: insights.window,
        narrative: narrative.narrative,
        hypothesis: narrative.hypothesis,
        confidence: narrative.confidence,
        evidence: resolveEvidence(narrative.evidence, insights.facts),
      };
    },
  );
};
