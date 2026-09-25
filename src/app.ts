import Fastify from "fastify";
import type { Config } from "./config.js";
import type { AppDatabase } from "./db/client.js";
import type { GitHubClient } from "./github/client.js";
import { errorToProblem, problem } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { syncRoutes } from "./routes/sync.js";

export type BuildAppOptions = {
  config: Config;
  logger?: false;
  production?: boolean;
  db?: AppDatabase;
  github?: GitHubClient;
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify(
    options.logger === false ? { logger: false } : { loggerInstance: createLogger(options.config) },
  );
  const secrets = [options.config.githubToken, options.config.anthropicApiKey];
  const production = options.production ?? process.env.NODE_ENV === "production";

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    void reply.status(404).send(problem(404, `Route ${request.method} ${path} not found`));
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const body = errorToProblem(error, { production, secrets });
    void reply.status(body.status).send(body);
  });

  await app.register(healthRoutes);
  if (options.db && options.github) {
    await app.register(syncRoutes, { db: options.db, github: options.github });
  }
  return app;
}
