import type { AppDatabase } from "../db/client.js";
import {
  insertSyncRun,
  upsertPullRequest,
  upsertRepo,
  upsertReview,
  upsertReviewComment,
  upsertUser,
} from "../db/upserts.js";
import type { GitHubClient } from "../github/client.js";
import { fetchPullRequests } from "../github/pulls.js";
import { fetchReviews } from "../github/reviews.js";
import type { GitHubActor, PullRequestDto, PullRequestReviewsDto } from "../github/types.js";

export type SyncRepoQuery = {
  owner: string;
  repo: string;
  /** Inclusive window start, unix epoch seconds. */
  since: number;
  /** Inclusive window end, unix epoch seconds. */
  until: number;
};

export type SyncRepoOptions = {
  now?: () => number;
};

export type SyncRepoResult = {
  prCount: number;
  reviewCount: number;
  commentCount: number;
  window: { since: number; until: number };
  status: "succeeded";
};

function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

function syncError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function actorsIn(pulls: readonly PullRequestDto[], activity: readonly PullRequestReviewsDto[]) {
  const byId = new Map<number, GitHubActor>();
  const add = (actor: GitHubActor) => {
    byId.set(actor.githubId, actor);
  };
  for (const pull of pulls) add(pull.author);
  for (const item of activity) {
    for (const review of item.reviews) add(review.reviewer);
    for (const comment of item.reviewComments) add(comment.reviewer);
  }
  return byId;
}

function userId(ids: ReadonlyMap<number, number>, actor: GitHubActor, label: string): number {
  const id = ids.get(actor.githubId);
  if (id === undefined) {
    throw syncError(500, `${label} is missing user ${actor.login}`);
  }
  return id;
}

/**
 * Fetch a repo window and upsert it in one transaction.
 * A failed fetch writes nothing. A failed write rolls the whole run back.
 * Re-running the same window updates rows in place; each attempt appends a sync_runs row.
 */
export async function syncRepo(
  client: GitHubClient,
  db: AppDatabase,
  query: SyncRepoQuery,
  options: SyncRepoOptions = {},
): Promise<SyncRepoResult> {
  const now = options.now ?? epochNow;
  const startedAt = now();
  const pulls = await fetchPullRequests(client, query);
  const activity = await fetchReviews(client, {
    owner: query.owner,
    repo: query.repo,
    pullNumbers: pulls.map((pull) => pull.number),
  });
  const finishedAt = now();
  const actors = actorsIn(pulls, activity);

  return db.transaction((tx) => {
    const repoId = upsertRepo(tx, query.owner, query.repo);
    const ids = new Map<number, number>();
    for (const actor of actors.values()) {
      ids.set(actor.githubId, upsertUser(tx, actor));
    }

    const prIds = new Map<number, number>();
    for (const pull of pulls) {
      const authorId = userId(ids, pull.author, `Pull request #${pull.number}`);
      prIds.set(pull.number, upsertPullRequest(tx, repoId, pull, authorId));
    }

    let reviewCount = 0;
    let commentCount = 0;
    for (const item of activity) {
      const prId = prIds.get(item.pullNumber);
      if (prId === undefined) {
        throw syncError(500, `Review activity for #${item.pullNumber} has no synced pull request`);
      }
      for (const review of item.reviews) {
        const reviewerId = userId(ids, review.reviewer, `Review ${review.githubId}`);
        upsertReview(tx, review, prId, reviewerId);
        reviewCount += 1;
      }
      for (const comment of item.reviewComments) {
        const reviewerId = userId(ids, comment.reviewer, `Review comment ${comment.githubId}`);
        upsertReviewComment(tx, comment, prId, reviewerId);
        commentCount += 1;
      }
    }

    insertSyncRun(tx, {
      repoId,
      since: query.since,
      until: query.until,
      startedAt,
      finishedAt,
      prCount: pulls.length,
      status: "succeeded",
    });

    return {
      prCount: pulls.length,
      reviewCount,
      commentCount,
      window: { since: query.since, until: query.until },
      status: "succeeded",
    };
  });
}
