import Fastify from "fastify";
import type { DestinationStream } from "pino";
import type { Config } from "./config.js";
import type { AppDatabase } from "./db/client.js";
import type { GitHubClient } from "./github/client.js";
import type { LLMProvider } from "./llm/provider.js";
import { errorToProblem, problem } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { insightsRoutes } from "./routes/insights.js";
import { insightsGraphRoutes } from "./routes/insightsGraph.js";
import { narrativeRoutes, type NarrativeRateLimit } from "./routes/narrative.js";
import { reposRoutes } from "./routes/repos.js";
import { syncRoutes } from "./routes/sync.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Vite forwards the browser Origin. Curl sends none. Anything else must not mutate. */
function isLocalOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

export type BuildAppOptions = {
  config: Config;
  logger?: false;
  logStream?: DestinationStream;
  production?: boolean;
  db?: AppDatabase;
  github?: GitHubClient;
  /** Injected completion seam. Without it, POST /narrative is not registered. */
  llm?: LLMProvider;
  /** Overrides the narrative route's per-IP limit. Production uses the route defaults. */
  narrativeRateLimit?: NarrativeRateLimit;
  /** Epoch milliseconds. Used for omitted insight bounds and the narrative rate-limit clock. */
  now?: () => number;
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify(
    options.logger === false
      ? { logger: false }
      : { loggerInstance: createLogger(options.config, options.logStream) },
  );
  const secrets = [options.config.githubToken, options.config.anthropicApiKey];
  const production = options.production ?? process.env.NODE_ENV === "production";

  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origins = originsOf(request.headers.origin);
    if (origins.length === 0 || origins.every(isLocalOrigin)) return;
    request.log.warn("Cross-origin request rejected");
    return reply.status(403).send(problem(403, "Cross-origin request rejected"));
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    void reply.status(404).send(problem(404, `Route ${request.method} ${path} not found`));
  });

  app.setErrorHandler((error, request, reply) => {
    const body = errorToProblem(error, { production, secrets });
    if (body.status >= 500) request.log.error(error);
    else request.log.warn({ statusCode: body.status }, body.message);
    void reply.status(body.status).send(body);
  });

  await app.register(healthRoutes);
  if (options.github) {
    await app.register(reposRoutes, { github: options.github });
  }
  if (options.db && options.github) {
    await app.register(syncRoutes, { db: options.db, github: options.github });
  }
  if (options.db) {
    await app.register(insightsRoutes, {
      db: options.db,
      config: options.config,
      now: options.now,
    });
    await app.register(insightsGraphRoutes, {
      db: options.db,
      config: options.config,
      now: options.now,
    });
  }
  if (options.db && options.llm) {
    await app.register(narrativeRoutes, {
      db: options.db,
      config: options.config,
      provider: options.llm,
      now: options.now,
      rateLimit: options.narrativeRateLimit,
    });
  }
  return app;
}
