import { z } from "zod";
import { formatSyncIssues, GITHUB_SLUG, parseInstant } from "./sync.js";

/**
 * Model completion for `/narrative`, before evidence ids are checked or resolved.
 * `hypothesis` is null when the facts do not support a cause — Decisions Q24.
 * Confidence bounds are enforced here. The API JSON Schema drops min/max — Q21, Q26.
 * Whether an evidence id was actually provided is `synthesize` (T22), not this schema.
 */
export const narrativeOutputSchema = z
  .object({
    narrative: z.string().min(1),
    hypothesis: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1)),
  })
  .strict();

export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;

const slug = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(GITHUB_SLUG, "must match ^[A-Za-z0-9_.-]+$");

const optionalInstant = z
  .union([z.number(), z.string()], {
    invalid_type_error: "must be an ISO-8601 date or unix epoch seconds",
  })
  .optional();

/**
 * Same instant forms as the insights query, including a digit string, so a client can echo
 * `window.since` without converting it. An empty string is invalid, not an omitted bound.
 */
function parseBodyInstant(value: number | string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return parseInstant(Number(value));
  return parseInstant(value);
}

/**
 * POST /narrative body. Omitted bounds are left unset so the insights loader applies the
 * default 30-day window. The model is not a body field — it comes from config. Decisions Q31.
 */
export const narrativeBodySchema = z
  .object({
    owner: slug,
    repo: slug,
    since: optionalInstant,
    until: optionalInstant,
  })
  .strict()
  .superRefine((value, ctx) => {
    const since = parseBodyInstant(value.since);
    const until = parseBodyInstant(value.until);
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
    const since = parseBodyInstant(value.since);
    const until = parseBodyInstant(value.until);
    return {
      owner: value.owner,
      repo: value.repo,
      ...(typeof since === "number" ? { since } : {}),
      ...(typeof until === "number" ? { until } : {}),
    };
  });

export type NarrativeBody = z.infer<typeof narrativeBodySchema>;

const windowSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    since: z.number().int().nonnegative(),
    until: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Wire response. Evidence is the model's id list, in order, each resolved to the fact's value.
 * Null is a missing sample, not zero. `window` is the resolved bounds, not the raw body.
 */
export const narrativeResponseSchema = z
  .object({
    window: windowSchema,
    narrative: z.string().min(1),
    hypothesis: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(
      z
        .object({
          id: z.string().min(1),
          value: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type NarrativeResponse = z.infer<typeof narrativeResponseSchema>;

export function formatNarrativeIssues(error: z.ZodError): string {
  return formatSyncIssues(error);
}
