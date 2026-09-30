import { and, eq, gte, lte } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import { syncRuns } from "../db/schema.js";
import { buildFacts } from "../facts/build.js";
import { httpError, validationError } from "../lib/errors.js";
import { computeCycleTime } from "../metrics/cycletime.js";
import { buildLeaderboards } from "../metrics/leaderboards.js";
import { computeLoadBalance } from "../metrics/loadbalance.js";
import { loadMetricWindow } from "../metrics/loaders.js";
import { buildReciprocityGraph, type ReciprocityGraph } from "../metrics/reciprocity.js";
import { detectRubberStamps } from "../metrics/rubberstamp.js";
import {
  formatInsightsIssues,
  insightsQuerySchema,
  insightsResponseSchema,
  type InsightsQuery,
  type InsightsResponse,
} from "../schemas/insights.js";

export type InsightsConfig = Pick<
  Config,
  "fastApprovalSeconds" | "minPrSize" | "minReciprocityInteractions"
>;

export type InsightsRouteOptions = {
  db: AppDatabase;
  config: InsightsConfig;
  /** Milliseconds since the epoch. Defaults to Date.now. Used only to resolve omitted bounds. */
  now?: () => number;
};

/**
 * A window is synced only when a succeeded run fully covers it.
 * A narrower or failed run is not enough: metrics would look complete while GitHub was never read
 * for part of the range. In-progress runs are the same hint — call POST /sync, then retry.
 */
export function assertSynced(
  db: AppDatabase,
  repoId: number,
  owner: string,
  repo: string,
  since: number,
  until: number,
): void {
  const covered = db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.repoId, repoId),
        eq(syncRuns.status, "succeeded"),
        lte(syncRuns.since, since),
        gte(syncRuns.until, until),
      ),
    )
    .get();
  if (covered) return;
  throw httpError(
    409,
    `No synced data for ${owner}/${repo} between ${since} and ${until}. POST /sync with this owner, repo, since, and until first.`,
  );
}

function summarizeReciprocity(graph: ReciprocityGraph): InsightsResponse["reciprocitySummary"] {
  const flaggedEdges = graph.edges
    .filter((edge) => edge.flagged)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      reverseWeight: edge.reverseWeight,
    }));
  return {
    minInteractions: graph.minInteractions,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    flaggedEdgeCount: flaggedEdges.length,
    flaggedEdges,
  };
}

/**
 * Read-side insights for one repo window. GitHub is not called.
 * Omitted bounds are resolved by `loadMetricWindow` and echoed on `window`.
 */
export function loadInsights(
  db: AppDatabase,
  config: InsightsConfig,
  query: InsightsQuery,
  options: { now?: () => number } = {},
): InsightsResponse {
  const metricWindow = loadMetricWindow(db, query, { now: options.now });

  assertSynced(
    db,
    metricWindow.repo.id,
    query.owner,
    query.repo,
    metricWindow.since,
    metricWindow.until,
  );

  const reciprocity = buildReciprocityGraph(metricWindow, {
    minInteractions: config.minReciprocityInteractions,
  });
  const rubberStamp = detectRubberStamps(metricWindow, {
    fastApprovalSeconds: config.fastApprovalSeconds,
    minPrSize: config.minPrSize,
  });
  const cycleTime = computeCycleTime(metricWindow);
  const loadBalance = computeLoadBalance(metricWindow);
  const leaderboards = buildLeaderboards(metricWindow);

  return {
    window: {
      owner: metricWindow.repo.owner,
      repo: metricWindow.repo.name,
      since: metricWindow.since,
      until: metricWindow.until,
    },
    facts: buildFacts({ reciprocity, rubberStamp, cycleTime, loadBalance, leaderboards }),
    leaderboards,
    cycleTime,
    rubberStamp,
    reciprocitySummary: summarizeReciprocity(reciprocity),
  };
}

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
