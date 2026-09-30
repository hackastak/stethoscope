import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { validationError } from "../lib/errors.js";
import {
  formatInsightsIssues,
  insightsQuerySchema,
  insightsResponseSchema,
  type InsightsQuery,
} from "../schemas/insights.js";
import { loadInsights, type InsightsConfig } from "../services/insights.js";

export type InsightsRouteOptions = {
  db: AppDatabase;
  config: InsightsConfig;
  /** Milliseconds since the epoch. Defaults to Date.now. Used only to resolve omitted bounds. */
  now?: () => number;
};

export const insightsRoutes: FastifyPluginAsync<InsightsRouteOptions> = async (app, options) => {
  app.setValidatorCompiler(({ schema }) => {
    return (data) => {
      if (!(schema instanceof z.ZodType)) return { value: data };
      const parsed = schema.safeParse(data);
      if (!parsed.success) return { error: validationError(formatInsightsIssues(parsed.error)) };
      return { value: parsed.data };
    };
  });

  app.setSerializerCompiler(({ schema }) => {
    return (data) => {
      const value = schema instanceof z.ZodType ? schema.parse(data) : data;
      return JSON.stringify(value);
    };
  });

  app.get<{ Querystring: InsightsQuery }>(
    "/insights",
    {
      schema: {
        querystring: insightsQuerySchema,
        response: {
          200: insightsResponseSchema,
        },
      },
    },
    async (request) =>
      loadInsights(options.db, options.config, request.query, { now: options.now }),
  );
};
