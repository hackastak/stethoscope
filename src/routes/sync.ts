import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import type { GitHubClient } from "../github/client.js";
import { problem, validationError } from "../lib/errors.js";
import {
  clientIp,
  createFixedWindowLimiter,
  rateLimitMessage,
  type RateLimit,
} from "../lib/rateLimit.js";
import {
  formatSyncIssues,
  syncBodySchema,
  type SyncBody,
  type SyncResponse,
} from "../schemas/sync.js";
import { syncRepo } from "../sync/syncRepo.js";

/** Local demo budget. Not an env var — the config list is closed. Decisions Q33. */
export const SYNC_RATE_LIMIT_MAX = 10;
export const SYNC_RATE_LIMIT_WINDOW_MS = 60_000;

export type SyncRouteOptions = {
  db: AppDatabase;
  github: GitHubClient;
  /** Epoch milliseconds. Same clock the rate-limit window uses. Defaults to Date.now. */
  now?: () => number;
  rateLimit?: RateLimit;
};

export const syncRoutes: FastifyPluginAsync<SyncRouteOptions> = async (app, options) => {
  const limit = options.rateLimit ?? {
    max: SYNC_RATE_LIMIT_MAX,
    windowMs: SYNC_RATE_LIMIT_WINDOW_MS,
  };
  const now = options.now ?? Date.now;
  const limiter = createFixedWindowLimiter(limit.max, limit.windowMs, now);

  app.setValidatorCompiler(({ schema }) => {
    return (data) => {
      if (!(schema instanceof z.ZodType)) return { value: data };
      const parsed = schema.safeParse(data);
      if (!parsed.success) return { error: validationError(formatSyncIssues(parsed.error)) };
      return { value: parsed.data };
    };
  });

  app.post<{ Body: SyncBody }>(
    "/sync",
    {
      schema: {
        body: syncBodySchema,
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
            problem(429, rateLimitMessage("sync", limit.max, limit.windowMs, decision.retryAfterSeconds)),
          );
      },
    },
    async (request): Promise<SyncResponse> => {
      const result = await syncRepo(options.github, options.db, request.body);
      return {
        prCount: result.prCount,
        reviewCount: result.reviewCount,
        window: result.window,
      };
    },
  );
};
