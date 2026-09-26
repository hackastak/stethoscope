import type { MetricPullRequest, MetricReview, MetricUser } from "./loaders.js";

export type LeaderboardEntry = {
  githubId: number;
  login: string;
  count: number;
};

export type Leaderboards = {
  /** Non-self review submissions. Every state counts, including DISMISSED. Repeat reviews count again. */
  reviewers: LeaderboardEntry[];
  /** One per pull request in the window, credited to its author. */
  authors: LeaderboardEntry[];
  /**
   * Authors of merged pull requests. GitHub's merger login is not stored, so this is who landed
   * the work, not who pressed merge. Closed-without-merge does not count.
   */
  closers: LeaderboardEntry[];
};

/**
 * Higher count first. Equal counts break by login, then github id, so the same window always
 * ranks the same way. Shared with load balance so a distribution and a board cannot disagree.
 */
export function compareByCountDesc(left: LeaderboardEntry, right: LeaderboardEntry): number {
  if (left.count !== right.count) return right.count - left.count;
  if (left.login < right.login) return -1;
  if (left.login > right.login) return 1;
  return left.githubId - right.githubId;
}

function remember(counts: Map<number, LeaderboardEntry>, user: MetricUser): void {
  const existing = counts.get(user.githubId);
  counts.set(user.githubId, {
    githubId: user.githubId,
    login: existing?.login ?? user.login,
    count: (existing?.count ?? 0) + 1,
  });
}

function isSelfReview(pullRequest: MetricPullRequest, review: MetricReview): boolean {
  return review.reviewer.githubId === pullRequest.author.githubId;
}

/** Review submissions that are not the author's own. People with none are omitted. */
export function reviewContributions(
  pullRequests: readonly MetricPullRequest[],
): LeaderboardEntry[] {
  const counts = new Map<number, LeaderboardEntry>();
  for (const pullRequest of pullRequests) {
    for (const review of pullRequest.reviews) {
      if (isSelfReview(pullRequest, review)) continue;
      remember(counts, review.reviewer);
    }
  }
  return [...counts.values()];
}

/** Pull requests authored. People with none are omitted. */
export function authorshipContributions(
  pullRequests: readonly MetricPullRequest[],
): LeaderboardEntry[] {
  const counts = new Map<number, LeaderboardEntry>();
  for (const pullRequest of pullRequests) remember(counts, pullRequest.author);
  return [...counts.values()];
}

function closerContributions(pullRequests: readonly MetricPullRequest[]): LeaderboardEntry[] {
  const counts = new Map<number, LeaderboardEntry>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.mergedAt === null) continue;
    remember(counts, pullRequest.author);
  }
  return [...counts.values()];
}

function rank(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort(compareByCountDesc);
}

/**
 * Top reviewers, authors, and closers for an already-loaded window.
 * Zero-count people are omitted. Order is count descending, then login, then github id.
 */
export function buildLeaderboards(input: {
  pullRequests: readonly MetricPullRequest[];
}): Leaderboards {
  return {
    reviewers: rank(reviewContributions(input.pullRequests)),
    authors: rank(authorshipContributions(input.pullRequests)),
    closers: rank(closerContributions(input.pullRequests)),
  };
}
