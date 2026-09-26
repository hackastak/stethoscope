import type { MetricPullRequest, MetricUser } from "./loaders.js";
import {
  authorshipContributions,
  compareByCountDesc,
  reviewContributions,
  type LeaderboardEntry,
} from "./leaderboards.js";

/**
 * Smallest set of people covering this fraction of an activity.
 * Not an env threshold — Project Overview only documents the three false-positive knobs.
 */
export const DEFAULT_BUS_FACTOR_COVERAGE = 0.5;

export type LoadShare = LeaderboardEntry & {
  /** `count / total`. 0 when the activity total is 0, so an idle team does not produce NaN. */
  share: number;
};

export type Concentration = {
  /**
   * Population Gini of the per-person counts, idle people included.
   * 0 is uniform. `(n - 1) / n` is one person doing all of it. Null when there is nothing to share
   * or nobody to share it across — not zero, which would look balanced.
   */
  gini: number | null;
  population: number;
  total: number;
};

export type BusFactor = {
  /** Minimum people whose counts cover `coverage` of `total`. Null when `total` is 0. */
  count: number | null;
  coverage: number;
  total: number;
  /** The covering prefix, highest count first, with the same tie-break as the leaderboards. */
  contributors: LoadShare[];
};

export type ActivityBalance = {
  /** Whole team, including zeros. Same order as a leaderboard, so the top row is the top person. */
  distribution: LoadShare[];
  concentration: Concentration;
  busFactor: BusFactor;
};

export type LoadBalanceReport = {
  coverage: number;
  reviews: ActivityBalance;
  authorship: ActivityBalance;
};

export type ComputeLoadBalanceOptions = {
  /** In (0, 1]. Defaults to half. */
  coverage?: number;
};

/**
 * Population Gini. Counts are sorted ascending; rank `i` is 1-based.
 * `G = (2 * Σ i * x_i) / (n * Σ x_i) - (n + 1) / n`.
 */
function gini(counts: readonly number[]): number | null {
  if (counts.length === 0) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const sorted = [...counts].sort((left, right) => left - right);
  const weighted = sorted.reduce((sum, count, index) => sum + (index + 1) * count, 0);
  const population = sorted.length;
  return (2 * weighted) / (population * total) - (population + 1) / population;
}

function assertCoverage(coverage: number): void {
  if (!Number.isFinite(coverage) || coverage <= 0 || coverage > 1) {
    throw new Error("coverage must be greater than 0 and at most 1");
  }
}

function remember(team: Map<number, MetricUser>, user: MetricUser): void {
  if (!team.has(user.githubId)) team.set(user.githubId, user);
}

/** Authors, reviewers, and commenters. A comment-only person is on the team and carries no reviews. */
function teamOf(pullRequests: readonly MetricPullRequest[]): MetricUser[] {
  const team = new Map<number, MetricUser>();
  for (const pullRequest of pullRequests) {
    remember(team, pullRequest.author);
    for (const review of pullRequest.reviews) remember(team, review.reviewer);
    for (const comment of pullRequest.comments) remember(team, comment.reviewer);
  }
  return [...team.values()];
}

function distributionOf(
  team: readonly MetricUser[],
  counts: readonly LeaderboardEntry[],
): LoadShare[] {
  const byId = new Map(counts.map((entry) => [entry.githubId, entry.count]));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return team
    .map((user) => ({
      githubId: user.githubId,
      login: user.login,
      count: byId.get(user.githubId) ?? 0,
    }))
    .sort(compareByCountDesc)
    .map((entry) => ({ ...entry, share: total === 0 ? 0 : entry.count / total }));
}

function busFactor(ranked: readonly LoadShare[], total: number, coverage: number): BusFactor {
  if (total === 0) return { count: null, coverage, total, contributors: [] };
  const needed = total * coverage;
  const contributors: LoadShare[] = [];
  let running = 0;
  for (const entry of ranked) {
    if (entry.count === 0) continue;
    running += entry.count;
    contributors.push(entry);
    if (running >= needed) break;
  }
  return { count: contributors.length, coverage, total, contributors };
}

function balance(
  team: readonly MetricUser[],
  counts: readonly LeaderboardEntry[],
  coverage: number,
): ActivityBalance {
  const distribution = distributionOf(team, counts);
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return {
    distribution,
    concentration: {
      gini: gini(distribution.map((entry) => entry.count)),
      population: team.length,
      total,
    },
    busFactor: busFactor(distribution, total, coverage),
  };
}

/**
 * Review-load concentration and bus factor for an already-loaded window.
 * Review load matches the reviewer leaderboard: each non-self review submission counts once,
 * and a review comment with no review does not. Idle teammates stay in the Gini population —
 * dropping them would report a single reviewer as perfectly balanced.
 * Authorship bus factor uses pull-request count, not lines.
 */
export function computeLoadBalance(
  input: { pullRequests: readonly MetricPullRequest[] },
  options: ComputeLoadBalanceOptions = {},
): LoadBalanceReport {
  const coverage = options.coverage ?? DEFAULT_BUS_FACTOR_COVERAGE;
  assertCoverage(coverage);
  const team = teamOf(input.pullRequests);
  return {
    coverage,
    reviews: balance(team, reviewContributions(input.pullRequests), coverage),
    authorship: balance(team, authorshipContributions(input.pullRequests), coverage),
  };
}
