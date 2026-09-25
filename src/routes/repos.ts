import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import { listRepos } from "../github/repos.js";
import { formatReposIssues, reposQuerySchema, type ReposQuery } from "../schemas/repos.js";

export type ReposRouteOptions = {
  github: GitHubClient;
};

function validationError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export const reposRoutes: FastifyPluginAsync<ReposRouteOptions> = async (app, options) => {
  app.setValidatorCompiler(({ schema }) => {
    return (data) => {
      if (!(schema instanceof z.ZodType)) return { value: data };
      const parsed = schema.safeParse(data);
      if (!parsed.success) return { error: validationError(formatReposIssues(parsed.error)) };
      return { value: parsed.data };
    };
  });

  app.get<{ Querystring: ReposQuery }>(
    "/repos",
    {
      schema: {
        querystring: reposQuerySchema,
      },
    },
    async (request) => listRepos(options.github, request.query),
  );
};
