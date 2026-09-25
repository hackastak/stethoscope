import { and, asc, eq, gte, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../db/client.js";
import {
  pullRequests,
  repos,
  reviewComments,
  reviews,
  users,
  type PrState,
  type ReviewState,
} from "../db/schema.js";

export type MetricUser = {
  id: number;
  githubId: number;
  login: string;
};

export type MetricReview = {
  id: number;
  githubId: number;
  state: ReviewState;
  submittedAt: number;
  bodyLen: number;
  commentCount: number;
  reviewer: MetricUser;
};

export type MetricComment = {
  id: number;
  githubId: number;
  createdAt: number;
  reviewer: MetricUser;
};

export type MetricPullRequest = {
  id: number;
  githubId: number;
  number: number;
  state: PrState;
  createdAt: number;
  readyAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  lastCommitAt: number | null;
  author: MetricUser;
  reviews: MetricReview[];
  comments: MetricComment[];
};

export type MetricWindow = {
  repo: { id: number; owner: string; name: string };
  since: number;
  until: number;
  pullRequests: MetricPullRequest[];
  users: MetricUser[];
};

/** Default metric span when `since` is omitted: 30 days, in seconds. */
export const DEFAULT_METRIC_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type MetricWindowQuery = {
  owner: string;
  repo: string;
  /** Inclusive window start, unix epoch seconds. Defaults to 30 days before now. */
  since?: number;
  /** Inclusive window end, unix epoch seconds. Defaults to now. */
  until?: number;
};

export type LoadMetricWindowOptions = {
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
};

const author = alias(users, "author");
const reviewer = alias(users, "reviewer");

function loaderError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function assertWindow(since: number, until: number): void {
  if (!Number.isInteger(since) || since < 0 || !Number.isInteger(until) || until < 0) {
    throw loaderError(400, "since and until must be unix epoch seconds");
  }
  if (until < since) throw loaderError(400, "until must be on or after since");
}

/**
 * Same overlap as the PR fetcher: [created_at, closed_at ?? merged_at ?? ongoing]
 * intersects [since, until], inclusive. closed_at wins when both close stamps exist.
 */
function prOverlaps(since: number, until: number): SQL {
  const filter = and(
    lte(pullRequests.createdAt, until),
    or(
      and(isNotNull(pullRequests.closedAt), gte(pullRequests.closedAt, since)),
      and(
        isNull(pullRequests.closedAt),
        isNotNull(pullRequests.mergedAt),
        gte(pullRequests.mergedAt, since),
      ),
      and(isNull(pullRequests.closedAt), isNull(pullRequests.mergedAt)),
    ),
  );
  if (!filter) throw loaderError(500, "Failed to build the metric window filter");
  return filter;
}

function compareUsers(left: MetricUser, right: MetricUser): number {
  if (left.login < right.login) return -1;
  if (left.login > right.login) return 1;
  return left.githubId - right.githubId;
}

function remember(usersById: Map<number, MetricUser>, user: MetricUser): void {
  if (!usersById.has(user.id)) usersById.set(user.id, user);
}

/**
 * Load one repo's metric input. Three reads after the repo lookup, independent of PR count.
 * Bot-authored PRs are omitted. Bot reviews and comments are omitted from the PRs that remain.
 * Reviews and comments stay attached even when their own timestamps fall outside the window.
 * An omitted until is the current time. An omitted since is 30 days before that same instant.
 */
export function loadMetricWindow(
  db: AppDatabase,
  query: MetricWindowQuery,
  options: LoadMetricWindowOptions = {},
): MetricWindow {
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const resolved: MetricWindowQuery & { since: number; until: number } = {
    ...query,
    since: query.since ?? nowSeconds - DEFAULT_METRIC_WINDOW_SECONDS,
    until: query.until ?? nowSeconds,
  };
  assertWindow(resolved.since, resolved.until);
  const repo = db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.owner, resolved.owner), eq(repos.name, resolved.repo)))
    .get();
  if (!repo) throw loaderError(404, `Repository ${resolved.owner}/${resolved.repo} not found`);

  const overlap = prOverlaps(resolved.since, resolved.until);
  const pullRows = db
    .select({
      id: pullRequests.id,
      githubId: pullRequests.githubId,
      number: pullRequests.number,
      state: pullRequests.state,
      createdAt: pullRequests.createdAt,
      readyAt: pullRequests.readyAt,
      mergedAt: pullRequests.mergedAt,
      closedAt: pullRequests.closedAt,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      lastCommitAt: pullRequests.lastCommitAt,
      authorId: users.id,
      authorGithubId: users.githubId,
      authorLogin: users.login,
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(and(eq(pullRequests.repoId, repo.id), eq(users.isBot, false), overlap))
    .orderBy(asc(pullRequests.number))
    .all();

  const reviewRows = db
    .select({
      id: reviews.id,
      githubId: reviews.githubId,
      prId: reviews.prId,
      state: reviews.state,
      submittedAt: reviews.submittedAt,
      bodyLen: reviews.bodyLen,
      commentCount: reviews.commentCount,
      reviewerId: reviewer.id,
      reviewerGithubId: reviewer.githubId,
      reviewerLogin: reviewer.login,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(reviews.prId, pullRequests.id))
    .innerJoin(author, eq(pullRequests.authorId, author.id))
    .innerJoin(reviewer, eq(reviews.reviewerId, reviewer.id))
    .where(
      and(
        eq(pullRequests.repoId, repo.id),
        eq(author.isBot, false),
        eq(reviewer.isBot, false),
        overlap,
      ),
    )
    .orderBy(asc(reviews.submittedAt), asc(reviews.githubId))
    .all();

  const commentRows = db
    .select({
      id: reviewComments.id,
      githubId: reviewComments.githubId,
      prId: reviewComments.prId,
      createdAt: reviewComments.createdAt,
      reviewerId: reviewer.id,
      reviewerGithubId: reviewer.githubId,
      reviewerLogin: reviewer.login,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(reviewComments.prId, pullRequests.id))
    .innerJoin(author, eq(pullRequests.authorId, author.id))
    .innerJoin(reviewer, eq(reviewComments.reviewerId, reviewer.id))
    .where(
      and(
        eq(pullRequests.repoId, repo.id),
        eq(author.isBot, false),
        eq(reviewer.isBot, false),
        overlap,
      ),
    )
    .orderBy(asc(reviewComments.createdAt), asc(reviewComments.githubId))
    .all();

  return assemble(repo, resolved, pullRows, reviewRows, commentRows);
}

type PullRow = {
  id: number;
  githubId: number;
  number: number;
  state: PrState;
  createdAt: number;
  readyAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  lastCommitAt: number | null;
  authorId: number;
  authorGithubId: number;
  authorLogin: string;
};

type ReviewRow = {
  id: number;
  githubId: number;
  prId: number;
  state: ReviewState;
  submittedAt: number;
  bodyLen: number;
  commentCount: number;
  reviewerId: number;
  reviewerGithubId: number;
  reviewerLogin: string;
};

type CommentRow = {
  id: number;
  githubId: number;
  prId: number;
  createdAt: number;
  reviewerId: number;
  reviewerGithubId: number;
  reviewerLogin: string;
};

function assemble(
  repo: MetricWindow["repo"],
  query: MetricWindowQuery & { since: number; until: number },
  pullRows: PullRow[],
  reviewRows: ReviewRow[],
  commentRows: CommentRow[],
): MetricWindow {
  const reviewsByPr = new Map<number, MetricReview[]>();
  const commentsByPr = new Map<number, MetricComment[]>();
  const usersById = new Map<number, MetricUser>();

  for (const row of reviewRows) {
    const reviewer = {
      id: row.reviewerId,
      githubId: row.reviewerGithubId,
      login: row.reviewerLogin,
    };
    const list = reviewsByPr.get(row.prId) ?? [];
    reviewsByPr.set(row.prId, [
      ...list,
      {
        id: row.id,
        githubId: row.githubId,
        state: row.state,
        submittedAt: row.submittedAt,
        bodyLen: row.bodyLen,
        commentCount: row.commentCount,
        reviewer,
      },
    ]);
    remember(usersById, reviewer);
  }

  for (const row of commentRows) {
    const commenter = {
      id: row.reviewerId,
      githubId: row.reviewerGithubId,
      login: row.reviewerLogin,
    };
    const list = commentsByPr.get(row.prId) ?? [];
    commentsByPr.set(row.prId, [
      ...list,
      {
        id: row.id,
        githubId: row.githubId,
        createdAt: row.createdAt,
        reviewer: commenter,
      },
    ]);
    remember(usersById, commenter);
  }

  const pulls = pullRows.map((row) => {
    const authorUser = { id: row.authorId, githubId: row.authorGithubId, login: row.authorLogin };
    remember(usersById, authorUser);
    return {
      id: row.id,
      githubId: row.githubId,
      number: row.number,
      state: row.state,
      createdAt: row.createdAt,
      readyAt: row.readyAt,
      mergedAt: row.mergedAt,
      closedAt: row.closedAt,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
      lastCommitAt: row.lastCommitAt,
      author: authorUser,
      reviews: reviewsByPr.get(row.id) ?? [],
      comments: commentsByPr.get(row.id) ?? [],
    };
  });

  return {
    repo,
    since: query.since,
    until: query.until,
    pullRequests: pulls,
    users: [...usersById.values()].sort(compareUsers),
  };
}
