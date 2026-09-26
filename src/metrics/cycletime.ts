import type { MetricPullRequest, MetricReview, MetricUser } from "./loaders.js";

export type CycleTimeStats = {
  /** Merged PRs that had this interval. Missing and negative intervals are not in the sample. */
  count: number;
  /**
   * Seconds. Null when `count` is 0 — a missing stage is not a zero.
   * This is the Hyndman-Fan type-7 50th percentile (the usual interpolated median).
   */
  median: number | null;
  /** Seconds. Same type-7 definition at the 75th percentile. Null when `count` is 0. */
  p75: number | null;
};

export type CycleTimePull = {
  pullRequestId: number;
  pullRequestNumber: number;
  author: MetricUser;
  /**
   * Start of the first interval: `readyAt` when the sync stored one, otherwise `createdAt`.
   * The pull payload has no ready-for-review stamp, so most rows fall back to creation.
   */
  readyAt: number;
  /** Earliest non-author review of any state, including DISMISSED. Null when nobody else reviewed. */
  firstReviewAt: number | null;
  /** Earliest non-author APPROVED review. A self-approval does not open this stage. */
  firstApprovalAt: number | null;
  mergedAt: number;
  /** Null when there is no first review, or that review is before `readyAt`. */
  readyToFirstReview: number | null;
  /** Null when either stage is missing, or the approval is before the first review. */
  firstReviewToFirstApproval: number | null;
  /** Null when there is no first approval, or the approval is after merge. */
  firstApprovalToMerge: number | null;
};

export type CycleTimeReport = {
  /** Merged PRs only, ordered by number then id. Unmerged rows are omitted, not null-filled. */
  pulls: CycleTimePull[];
  readyToFirstReview: CycleTimeStats;
  firstReviewToFirstApproval: CycleTimeStats;
  firstApprovalToMerge: CycleTimeStats;
};

/**
 * Hyndman-Fan type 7, the R / NumPy / Excel PERCENTILE.INC definition.
 * `h = (n - 1) * p`, then linear interpolation between the surrounding sorted values.
 * One observation returns that observation for every p. An empty sample returns null.
 */
function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined || lower === upper) return low ?? null;
  return low + (index - lower) * (high - low);
}

function stats(samples: readonly number[]): CycleTimeStats {
  return {
    count: samples.length,
    median: percentile(samples, 0.5),
    p75: percentile(samples, 0.75),
  };
}

function isAuthor(pullRequest: MetricPullRequest, review: MetricReview): boolean {
  return review.reviewer.githubId === pullRequest.author.githubId;
}

function earliest(
  reviews: readonly MetricReview[],
  accept: (review: MetricReview) => boolean,
): number | null {
  let at: number | null = null;
  for (const review of reviews) {
    if (!accept(review)) continue;
    if (at === null || review.submittedAt < at) at = review.submittedAt;
  }
  return at;
}

/** Non-negative seconds from start to end. A missing stage or a backwards clock is null, never 0. */
function interval(end: number | null, start: number | null): number | null {
  if (end === null || start === null) return null;
  const seconds = end - start;
  return seconds < 0 ? null : seconds;
}

function isMerged(
  pullRequest: MetricPullRequest,
): pullRequest is MetricPullRequest & { mergedAt: number } {
  return pullRequest.mergedAt !== null;
}

function breakDown(pullRequest: MetricPullRequest & { mergedAt: number }): CycleTimePull {
  const mergedAt = pullRequest.mergedAt;
  const readyAt = pullRequest.readyAt ?? pullRequest.createdAt;
  const others = pullRequest.reviews.filter((review) => !isAuthor(pullRequest, review));
  const firstReviewAt = earliest(others, () => true);
  const firstApprovalAt = earliest(others, (review) => review.state === "APPROVED");
  return {
    pullRequestId: pullRequest.id,
    pullRequestNumber: pullRequest.number,
    author: pullRequest.author,
    readyAt,
    firstReviewAt,
    firstApprovalAt,
    mergedAt,
    readyToFirstReview: interval(firstReviewAt, readyAt),
    firstReviewToFirstApproval: interval(firstApprovalAt, firstReviewAt),
    firstApprovalToMerge: interval(mergedAt, firstApprovalAt),
  };
}

function comparePull(left: CycleTimePull, right: CycleTimePull): number {
  return (
    left.pullRequestNumber - right.pullRequestNumber || left.pullRequestId - right.pullRequestId
  );
}

/**
 * Cycle-time breakdown for merged PRs already loaded into a metric window.
 * Stages are ready (else created) → first non-author review → first non-author approval → merge.
 * A review comment with no review submission does not open the first-review stage.
 * Offline review is invisible. Draft time is included when `readyAt` was never stored.
 */
export function computeCycleTime(input: {
  pullRequests: readonly MetricPullRequest[];
}): CycleTimeReport {
  const pulls = input.pullRequests.filter(isMerged).map(breakDown).sort(comparePull);
  const readyToFirstReview = pulls.flatMap((pull) =>
    pull.readyToFirstReview === null ? [] : [pull.readyToFirstReview],
  );
  const firstReviewToFirstApproval = pulls.flatMap((pull) =>
    pull.firstReviewToFirstApproval === null ? [] : [pull.firstReviewToFirstApproval],
  );
  const firstApprovalToMerge = pulls.flatMap((pull) =>
    pull.firstApprovalToMerge === null ? [] : [pull.firstApprovalToMerge],
  );
  return {
    pulls,
    readyToFirstReview: stats(readyToFirstReview),
    firstReviewToFirstApproval: stats(firstReviewToFirstApproval),
    firstApprovalToMerge: stats(firstApprovalToMerge),
  };
}
