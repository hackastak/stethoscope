import { z } from "zod";

/** GitHub owner/repo slugs. Blocks path and URL injection into Octokit routes. */
export const GITHUB_SLUG = /^[A-Za-z0-9_.-]+$/;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const slug = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(GITHUB_SLUG, "must match ^[A-Za-z0-9_.-]+$");

const instantInput = z.union([z.number(), z.string()], {
  required_error: "is required",
  invalid_type_error: "must be an ISO-8601 date or unix epoch seconds",
});

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * Parse an instant into unix epoch seconds.
 * Date-only strings are UTC midnight. Date-times must carry a timezone.
 * Returns null when the value is not a real calendar instant.
 */
export function parseInstant(value: number | string): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isRealDate(year, month, day)) return null;
    return Math.floor(Date.UTC(year, month - 1, day) / 1000);
  }

  const dateTime = DATE_TIME.exec(value);
  if (!dateTime) return null;
  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]);
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = Number(dateTime[6]);
  if (!isRealDate(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

export const syncBodySchema = z
  .object({
    owner: slug,
    repo: slug,
    since: instantInput,
    until: instantInput,
  })
  .strict()
  .superRefine((value, ctx) => {
    const since = parseInstant(value.since);
    const until = parseInstant(value.until);
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
    if (since !== null && until !== null && until < since) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["until"],
        message: "must be on or after since",
      });
    }
  })
  .transform((value) => ({
    owner: value.owner,
    repo: value.repo,
    since: parseInstant(value.since) as number,
    until: parseInstant(value.until) as number,
  }));

export type SyncBody = z.infer<typeof syncBodySchema>;

export function formatSyncIssues(error: z.ZodError): string {
  if (error.issues.length === 0) return "Invalid request body";
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const label = issue.keys.length === 1 ? "key" : "keys";
        return `body: unrecognized ${label} ${issue.keys.join(", ")}`;
      }
      const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}
