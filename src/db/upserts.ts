import type { AppDatabase } from "./client.js";
import type { GitHubActor, PullRequestDto, ReviewCommentDto, ReviewDto } from "../github/types.js";
import {
  pullRequests,
  repos,
  reviewComments,
  reviews,
  syncRuns,
  users,
  type SyncStatus,
} from "./schema.js";

/** Drizzle transaction handle. Writes inside `syncRepo` must use this, not a fresh connection. */
export type SyncWriter = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

type RowId = { id: number };

function requireId(row: RowId | undefined, label: string): number {
  if (!row) {
    throw new Error(`Failed to upsert ${label}`);
  }
  return row.id;
}

export function upsertRepo(db: SyncWriter, owner: string, name: string): number {
  const row = db
    .insert(repos)
    .values({ owner, name })
    .onConflictDoUpdate({
      target: [repos.owner, repos.name],
      set: { name },
    })
    .returning({ id: repos.id })
    .get();
  return requireId(row, "repo");
}

export function upsertUser(db: SyncWriter, actor: GitHubActor): number {
  const row = db
    .insert(users)
    .values({
      githubId: actor.githubId,
      login: actor.login,
      isBot: actor.isBot,
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: { login: actor.login, isBot: actor.isBot },
    })
    .returning({ id: users.id })
    .get();
  return requireId(row, "user");
}

export function upsertPullRequest(
  db: SyncWriter,
  repoId: number,
  pull: PullRequestDto,
  authorId: number,
): number {
  const row = db
    .insert(pullRequests)
    .values({
      repoId,
      githubId: pull.githubId,
      number: pull.number,
      authorId,
      state: pull.state,
      createdAt: pull.createdAt,
      readyAt: pull.readyAt,
      mergedAt: pull.mergedAt,
      closedAt: pull.closedAt,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changedFiles,
      lastCommitAt: pull.lastCommitAt,
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        githubId: pull.githubId,
        authorId,
        state: pull.state,
        createdAt: pull.createdAt,
        readyAt: pull.readyAt,
        mergedAt: pull.mergedAt,
        closedAt: pull.closedAt,
        additions: pull.additions,
        deletions: pull.deletions,
        changedFiles: pull.changedFiles,
        lastCommitAt: pull.lastCommitAt,
      },
    })
    .returning({ id: pullRequests.id })
    .get();
  return requireId(row, "pull request");
}

export function upsertReview(
  db: SyncWriter,
  review: ReviewDto,
  prId: number,
  reviewerId: number,
): number {
  const row = db
    .insert(reviews)
    .values({
      githubId: review.githubId,
      prId,
      reviewerId,
      state: review.state,
      submittedAt: review.submittedAt,
      bodyLen: review.bodyLen,
      commentCount: review.commentCount,
    })
    .onConflictDoUpdate({
      target: reviews.githubId,
      set: {
        prId,
        reviewerId,
        state: review.state,
        submittedAt: review.submittedAt,
        bodyLen: review.bodyLen,
        commentCount: review.commentCount,
      },
    })
    .returning({ id: reviews.id })
    .get();
  return requireId(row, "review");
}

export function upsertReviewComment(
  db: SyncWriter,
  comment: ReviewCommentDto,
  prId: number,
  reviewerId: number,
): number {
  const row = db
    .insert(reviewComments)
    .values({
      githubId: comment.githubId,
      prId,
      reviewerId,
      createdAt: comment.createdAt,
    })
    .onConflictDoUpdate({
      target: reviewComments.githubId,
      set: { prId, reviewerId, createdAt: comment.createdAt },
    })
    .returning({ id: reviewComments.id })
    .get();
  return requireId(row, "review comment");
}

export function insertSyncRun(
  db: SyncWriter,
  run: {
    repoId: number;
    since: number;
    until: number;
    startedAt: number;
    finishedAt: number;
    prCount: number;
    status: SyncStatus;
  },
): number {
  const row = db.insert(syncRuns).values(run).returning({ id: syncRuns.id }).get();
  return requireId(row, "sync run");
}
