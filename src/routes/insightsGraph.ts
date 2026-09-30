import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { validationError } from "../lib/errors.js";
import {
  formatInsightsIssues,
  insightsGraphResponseSchema,
  insightsQuerySchema,
  type InsightsQuery,
} from "../schemas/insights.js";
import { loadInsightsGraph, type InsightsGraphConfig } from "../services/insights.js";

export type InsightsGraphRouteOptions = {
  db: AppDatabase;
  config: InsightsGraphConfig;
  /** Milliseconds since the epoch. Defaults to Date.now. Used only to resolve omitted bounds. */
  now?: () => number;
};

export const insightsGraphRoutes: FastifyPluginAsync<InsightsGraphRouteOptions> = async (
  app,
  options,
) => {
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
    "/insights/graph",
    {
      schema: {
        querystring: insightsQuerySchema,
        response: {
          200: insightsGraphResponseSchema,
        },
      },
    },
    async (request) =>
      loadInsightsGraph(options.db, options.config, request.query, { now: options.now }),
  );
};
