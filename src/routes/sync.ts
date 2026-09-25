import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import type { GitHubClient } from "../github/client.js";
import { formatSyncIssues, syncBodySchema, type SyncBody } from "../schemas/sync.js";
import { syncRepo } from "../sync/syncRepo.js";

export type SyncRouteOptions = {
  db: AppDatabase;
  github: GitHubClient;
};

function validationError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export const syncRoutes: FastifyPluginAsync<SyncRouteOptions> = async (app, options) => {
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
    },
    async (request) => {
      const result = await syncRepo(options.github, options.db, request.body);
      return {
        prCount: result.prCount,
        reviewCount: result.reviewCount,
        window: result.window,
      };
    },
  );
};
