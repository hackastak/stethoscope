/** UTC calendar dates as `YYYY-MM-DD`. */
export type UtcDateRange = {
  since: string;
  until: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 30-day default picker span. Must match the API read window
// (`DEFAULT_METRIC_WINDOW_SECONDS` in src/metrics/loaders.ts). Kept local, not a
// shared import: the two live in different packages (and the web imports src
// type-only by design), and each is independently pinned to 30 by its own test,
// so a drift on either side fails that side's suite.
export const DEFAULT_RANGE_DAYS = 30;

export function defaultUtcDateRange(nowMs: number): UtcDateRange {
  const until = new Date(nowMs).toISOString().slice(0, 10);
  const since = new Date(nowMs - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { since, until };
}

/**
 * Inclusive UTC instants for a picked calendar range.
 * `until` is the last second of that date so the end day is inside the window.
 * Returns null when a date is missing, malformed, or the range is inverted.
 */
export function resolveUtcDateRange(range: UtcDateRange): { since: string; until: string } | null {
  if (!DATE.test(range.since) || !DATE.test(range.until)) return null;
  if (range.until < range.since) return null;
  return {
    since: `${range.since}T00:00:00Z`,
    until: `${range.until}T23:59:59Z`,
  };
}

export function dateRangeBlockReason(range: UtcDateRange): string | null {
  if (!DATE.test(range.since) || !DATE.test(range.until)) {
    return "Sync needs both a since and an until date.";
  }
  if (range.until < range.since) return "Until must be on or after since.";
  return null;
}

/** Split a typed slug. Does not validate characters — the API owns that 400. */
export function splitOwnerRepo(slug: string): { owner: string; repo: string } {
  const trimmed = slug.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { owner: trimmed, repo: "" };
  return {
    owner: trimmed.slice(0, slash),
    repo: trimmed.slice(slash + 1),
  };
}
