import type { MetricPullRequest, MetricReview, MetricUser } from "./loaders.js";

/** Matches `FAST_APPROVAL_SECONDS` in config. Callers should pass the configured value. */
export const DEFAULT_FAST_APPROVAL_SECONDS = 300;

/** Matches `MIN_PR_SIZE` in config. Size is additions + deletions. Callers should pass the configured value. */
export const DEFAULT_MIN_PR_SIZE = 100;

export type RubberStampApproval = {
  reviewId: number;
  reviewGithubId: number;
  pullRequestId: number;
  pullRequestNumber: number;
  reviewer: MetricUser;
  author: MetricUser;
  /**
   * Seconds from the last commit at or before this review, else `readyAt`, else `createdAt`.
   * Always >= 0. An approval submitted before every baseline is not eligible.
   */
  timeToApproval: number;
  /**
   * Review comments this reviewer left on the PR, plus any count already stored on the approval.
   * Silence requires this to be 0. Another reviewer's comments do not count.
   */
  commentCount: number;
  /** `additions + deletions`. Changed-file count is not size. */
  prSize: number;
  /**
   * Low scrutiny: fast, silent, and larger than `minPrSize`. All three are required.
   * `timeToApproval === fastApprovalSeconds` is not fast. `prSize === minPrSize` is not large.
   */
  flagged: boolean;
};

export type RubberStampRate = {
  flagged: number;
  /**
   * APPROVED reviews with a non-negative time-to-approval.
   * Non-approvals and approvals submitted before every baseline are excluded, not counted as clean.
   */
  eligible: number;
  /** `flagged / eligible`. Null when `eligible` is 0 — absence is not a zero rate. */
  rate: number | null;
};

export type RubberStampReviewer = RubberStampRate & {
  reviewer: MetricUser;
};

export type RubberStampPair = RubberStampRate & {
  reviewer: MetricUser;
  author: MetricUser;
};

export type RubberStampReport = {
  fastApprovalSeconds: number;
  minPrSize: number;
  /** Eligible approvals only, ordered by PR number, submit time, then review github id. */
  approvals: RubberStampApproval[];
  /** One row per reviewer with at least one eligible approval. Rate is flagged / eligible. */
  reviewers: RubberStampReviewer[];
  /** Same denominator, split by reviewer → author, including self-approval. */
  pairs: RubberStampPair[];
};

export type DetectRubberStampsOptions = {
  fastApprovalSeconds?: number;
  minPrSize?: number;
};

type ApprovalDraft = RubberStampApproval & {
  submittedAt: number;
};

function compareLogin(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function prSize(pullRequest: MetricPullRequest): number {
  return pullRequest.additions + pullRequest.deletions;
}

/**
 * Last commit at or before the review. A later commit is not "before the review",
 * so the clock falls back to ready-for-review, then PR creation.
 */
function approvalBaseline(pullRequest: MetricPullRequest, submittedAt: number): number {
  if (pullRequest.lastCommitAt !== null && pullRequest.lastCommitAt <= submittedAt) {
    return pullRequest.lastCommitAt;
  }
  return pullRequest.readyAt ?? pullRequest.createdAt;
}

function reviewerCommentCount(pullRequest: MetricPullRequest, review: MetricReview): number {
  const onPullRequest = pullRequest.comments.filter(
    (entry) => entry.reviewer.githubId === review.reviewer.githubId,
  ).length;
  return Math.max(review.commentCount, onPullRequest);
}

function toRate(flagged: number, eligible: number): RubberStampRate {
  return { flagged, eligible, rate: eligible === 0 ? null : flagged / eligible };
}

function evaluate(
  pullRequest: MetricPullRequest,
  review: MetricReview,
  options: {
    fastApprovalSeconds: number;
    minPrSize: number;
  },
): ApprovalDraft | undefined {
  if (review.state !== "APPROVED") return undefined;
  const timeToApproval = review.submittedAt - approvalBaseline(pullRequest, review.submittedAt);
  if (timeToApproval < 0) return undefined;
  const commentCount = reviewerCommentCount(pullRequest, review);
  const size = prSize(pullRequest);
  return {
    reviewId: review.id,
    reviewGithubId: review.githubId,
    pullRequestId: pullRequest.id,
    pullRequestNumber: pullRequest.number,
    reviewer: review.reviewer,
    author: pullRequest.author,
    submittedAt: review.submittedAt,
    timeToApproval,
    commentCount,
    prSize: size,
    flagged:
      timeToApproval < options.fastApprovalSeconds &&
      commentCount === 0 &&
      size > options.minPrSize,
  };
}

/**
 * Low-scrutiny approvals for one already-loaded metric window.
 * A flag needs all three: faster than `fastApprovalSeconds`, zero comments by that reviewer on the PR,
 * and `additions + deletions` strictly above `minPrSize`. Does not read config.
 *
 * Offline or in-person review is invisible here and can false-positive. Small typo fixes are excluded by size.
 */
export function detectRubberStamps(
  input: { pullRequests: readonly MetricPullRequest[] },
  options: DetectRubberStampsOptions = {},
): RubberStampReport {
  const fastApprovalSeconds = options.fastApprovalSeconds ?? DEFAULT_FAST_APPROVAL_SECONDS;
  const minPrSize = options.minPrSize ?? DEFAULT_MIN_PR_SIZE;
  const drafts = input.pullRequests.flatMap((pullRequest) =>
    pullRequest.reviews.flatMap((review) => {
      const draft = evaluate(pullRequest, review, { fastApprovalSeconds, minPrSize });
      return draft ? [draft] : [];
    }),
  );
  const approvals = [...drafts]
    .sort(
      (left, right) =>
        left.pullRequestNumber - right.pullRequestNumber ||
        left.submittedAt - right.submittedAt ||
        left.reviewGithubId - right.reviewGithubId,
    )
    .map(({ submittedAt: _submittedAt, ...approval }) => approval);

  return {
    fastApprovalSeconds,
    minPrSize,
    approvals,
    reviewers: aggregateReviewers(approvals),
    pairs: aggregatePairs(approvals),
  };
}

function aggregateReviewers(approvals: readonly RubberStampApproval[]): RubberStampReviewer[] {
  const byReviewer = new Map<number, { reviewer: MetricUser; flagged: number; eligible: number }>();
  for (const approval of approvals) {
    const current = byReviewer.get(approval.reviewer.githubId) ?? {
      reviewer: approval.reviewer,
      flagged: 0,
      eligible: 0,
    };
    byReviewer.set(approval.reviewer.githubId, {
      ...current,
      flagged: current.flagged + (approval.flagged ? 1 : 0),
      eligible: current.eligible + 1,
    });
  }
  return [...byReviewer.values()]
    .map(({ reviewer, flagged, eligible }) => ({ reviewer, ...toRate(flagged, eligible) }))
    .sort(
      (left, right) =>
        compareLogin(left.reviewer.login, right.reviewer.login) ||
        left.reviewer.githubId - right.reviewer.githubId,
    );
}

function aggregatePairs(approvals: readonly RubberStampApproval[]): RubberStampPair[] {
  const byPair = new Map<
    string,
    { reviewer: MetricUser; author: MetricUser; flagged: number; eligible: number }
  >();
  for (const approval of approvals) {
    const key = `${approval.reviewer.githubId}->${approval.author.githubId}`;
    const current = byPair.get(key) ?? {
      reviewer: approval.reviewer,
      author: approval.author,
      flagged: 0,
      eligible: 0,
    };
    byPair.set(key, {
      ...current,
      flagged: current.flagged + (approval.flagged ? 1 : 0),
      eligible: current.eligible + 1,
    });
  }
  return [...byPair.values()]
    .map(({ reviewer, author, flagged, eligible }) => ({
      reviewer,
      author,
      ...toRate(flagged, eligible),
    }))
    .sort(
      (left, right) =>
        compareLogin(left.reviewer.login, right.reviewer.login) ||
        compareLogin(left.author.login, right.author.login) ||
        left.reviewer.githubId - right.reviewer.githubId ||
        left.author.githubId - right.author.githubId,
    );
}
