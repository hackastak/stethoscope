import { z } from "zod";
import { FACT_KINDS, FACT_UNITS } from "../facts/types.js";
import { GITHUB_SLUG, parseInstant } from "./sync.js";

const slug = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(GITHUB_SLUG, "must match ^[A-Za-z0-9_.-]+$");

const optionalInstant = z.union([z.number(), z.string()]).optional();

/**
 * Query strings arrive as text. Epoch seconds are accepted as digits so callers
 * can echo the numeric window from a previous response without converting it.
 */
function parseQueryInstant(value: number | string | undefined): number | null | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return parseInstant(Number(value));
  return parseInstant(value);
}

export const insightsQuerySchema = z
  .object({
    owner: slug,
    repo: slug,
    since: optionalInstant,
    until: optionalInstant,
  })
  .strict()
  .superRefine((value, ctx) => {
    const since = parseQueryInstant(value.since);
    const until = parseQueryInstant(value.until);
    if (since === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["since"],
        message: "must be an ISO-8601 date or unix epoch seconds",
      });
    }
    if (until === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["until"],
        message: "must be an ISO-8601 date or unix epoch seconds",
      });
    }
    if (
      since !== null &&
      since !== undefined &&
      until !== null &&
      until !== undefined &&
      until < since
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["until"],
        message: "must be on or after since",
      });
    }
  })
  .transform((value) => {
    const since = parseQueryInstant(value.since);
    const until = parseQueryInstant(value.until);
    return {
      owner: value.owner,
      repo: value.repo,
      ...(typeof since === "number" ? { since } : {}),
      ...(typeof until === "number" ? { until } : {}),
    };
  });

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

const metricUserSchema = z
  .object({
    id: z.number().int(),
    githubId: z.number().int(),
    login: z.string().min(1),
  })
  .strict();

// Derived from FACT_KINDS so the id prefix and the kind list have one definition, not two.
const FACT_ID_PATTERN = new RegExp(`^fact:(${FACT_KINDS.join("|")}):.+$`);

const factSchema = z
  .object({
    id: z.string().regex(FACT_ID_PATTERN),
    kind: z.enum(FACT_KINDS),
    subject: z.string().min(1),
    value: z.number().nullable(),
    unit: z.enum(FACT_UNITS),
    detail: z.string().min(1),
  })
  .strict();

const leaderboardEntrySchema = z
  .object({
    githubId: z.number().int(),
    login: z.string().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

const cycleTimeStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    median: z.number().nullable(),
    p75: z.number().nullable(),
  })
  .strict();

const cycleTimePullSchema = z
  .object({
    pullRequestId: z.number().int(),
    pullRequestNumber: z.number().int(),
    author: metricUserSchema,
    readyAt: z.number().int(),
    firstReviewAt: z.number().int().nullable(),
    firstApprovalAt: z.number().int().nullable(),
    mergedAt: z.number().int(),
    readyToFirstReview: z.number().nullable(),
    firstReviewToFirstApproval: z.number().nullable(),
    firstApprovalToMerge: z.number().nullable(),
  })
  .strict();

const rubberStampRateSchema = z
  .object({
    flagged: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    rate: z.number().nullable(),
  })
  .strict();

const rubberStampApprovalSchema = z
  .object({
    reviewId: z.number().int(),
    reviewGithubId: z.number().int(),
    pullRequestId: z.number().int(),
    pullRequestNumber: z.number().int(),
    reviewer: metricUserSchema,
    author: metricUserSchema,
    timeToApproval: z.number().int().nonnegative(),
    commentCount: z.number().int().nonnegative(),
    prSize: z.number().int().nonnegative(),
    flagged: z.boolean(),
  })
  .strict();

export const insightsResponseSchema = z
  .object({
    window: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        since: z.number().int().nonnegative(),
        until: z.number().int().nonnegative(),
      })
      .strict(),
    facts: z.array(factSchema),
    leaderboards: z
      .object({
        reviewers: z.array(leaderboardEntrySchema),
        authors: z.array(leaderboardEntrySchema),
        closers: z.array(leaderboardEntrySchema),
      })
      .strict(),
    cycleTime: z
      .object({
        pulls: z.array(cycleTimePullSchema),
        readyToFirstReview: cycleTimeStatsSchema,
        firstReviewToFirstApproval: cycleTimeStatsSchema,
        firstApprovalToMerge: cycleTimeStatsSchema,
      })
      .strict(),
    rubberStamp: z
      .object({
        fastApprovalSeconds: z.number().int().positive(),
        minPrSize: z.number().int().nonnegative(),
        approvals: z.array(rubberStampApprovalSchema),
        reviewers: z.array(rubberStampRateSchema.extend({ reviewer: metricUserSchema }).strict()),
        pairs: z.array(
          rubberStampRateSchema
            .extend({ reviewer: metricUserSchema, author: metricUserSchema })
            .strict(),
        ),
      })
      .strict(),
    reciprocitySummary: z
      .object({
        minInteractions: z.number().int().positive(),
        nodeCount: z.number().int().nonnegative(),
        edgeCount: z.number().int().nonnegative(),
        flaggedEdgeCount: z.number().int().nonnegative(),
        flaggedEdges: z.array(
          z
            .object({
              source: z.string().min(1),
              target: z.string().min(1),
              weight: z.number().int().positive(),
              reverseWeight: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export type InsightsResponse = z.infer<typeof insightsResponseSchema>;

const insightsGraphNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    reviewsGiven: z.number().int().nonnegative(),
    reviewsReceived: z.number().int().nonnegative(),
  })
  .strict();

const insightsGraphEdgeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    weight: z.number().int().positive(),
    flagged: z.boolean(),
  })
  .strict();

/** Frontend graph payload. Internal fields (github ids, scores, reverse weight) stay off the wire. */
export const insightsGraphResponseSchema = z
  .object({
    nodes: z.array(insightsGraphNodeSchema),
    edges: z.array(insightsGraphEdgeSchema),
  })
  .strict();

export type InsightsGraphResponse = z.infer<typeof insightsGraphResponseSchema>;

export function formatInsightsIssues(error: z.ZodError): string {
  if (error.issues.length === 0) return "Invalid query";
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const label = issue.keys.length === 1 ? "key" : "keys";
        return `query: unrecognized ${label} ${issue.keys.join(", ")}`;
      }
      const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "query";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}
