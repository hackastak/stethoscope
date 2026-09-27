import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import { buildReciprocityGraph } from "../metrics/reciprocity.js";
import { loadMetricWindow } from "../metrics/loaders.js";
import {
  formatInsightsIssues,
  insightsGraphResponseSchema,
  insightsQuerySchema,
  type InsightsGraphResponse,
  type InsightsQuery,
} from "../schemas/insights.js";
import { assertSynced, httpError } from "./insights.js";

export type InsightsGraphConfig = Pick<Config, "minReciprocityInteractions">;

export type InsightsGraphRouteOptions = {
  db: AppDatabase;
  config: InsightsGraphConfig;
  /** Milliseconds since the epoch. Defaults to Date.now. Used only to resolve omitted bounds. */
  now?: () => number;
};

function validationError(message: string): Error & { statusCode: number } {
  return httpError(400, message);
}

/**
 * Reciprocity network for the frontend graph.
 * Same window and sync rules as `loadInsights`. The wire shape drops github ids, scores, and reverse weight.
 */
export function loadInsightsGraph(
  db: AppDatabase,
  config: InsightsGraphConfig,
  query: InsightsQuery,
  options: { now?: () => number } = {},
): InsightsGraphResponse {
  const metricWindow = loadMetricWindow(db, query, { now: options.now });
  assertSynced(
    db,
    metricWindow.repo.id,
    query.owner,
    query.repo,
    metricWindow.since,
    metricWindow.until,
  );

  const graph = buildReciprocityGraph(metricWindow, {
    minInteractions: config.minReciprocityInteractions,
  });

  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      reviewsGiven: node.reviewsGiven,
      reviewsReceived: node.reviewsReceived,
    })),
    edges: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      flagged: edge.flagged,
    })),
  };
}

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
