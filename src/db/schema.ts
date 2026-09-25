import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Persisted GitHub review data.
 * Timestamps are unix epoch seconds so window filters and cycle-time math stay integer comparisons.
 * Identity columns (`github_id`, repo owner/name, PR number) exist so sync can upsert idempotently.
 */

export const prStates = ["open", "closed"] as const;
export type PrState = (typeof prStates)[number];

/** GitHub also emits DISMISSED; the metric-relevant states are the first three. */
export const reviewStates = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const;
export type ReviewState = (typeof reviewStates)[number];

export const syncStatuses = ["running", "succeeded", "failed"] as const;
export type SyncStatus = (typeof syncStatuses)[number];

export const repos = sqliteTable(
  "repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("repos_owner_name_idx").on(table.owner, table.name)],
);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    githubId: integer("github_id").notNull(),
    login: text("login").notNull(),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("users_github_id_idx").on(table.githubId),
    uniqueIndex("users_login_idx").on(table.login),
  ],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    githubId: integer("github_id").notNull(),
    number: integer("number").notNull(),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    state: text("state", { enum: prStates }).notNull(),
    createdAt: integer("created_at").notNull(),
    readyAt: integer("ready_at"),
    mergedAt: integer("merged_at"),
    closedAt: integer("closed_at"),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
    changedFiles: integer("changed_files").notNull(),
    lastCommitAt: integer("last_commit_at"),
  },
  (table) => [
    uniqueIndex("pull_requests_repo_number_idx").on(table.repoId, table.number),
    uniqueIndex("pull_requests_github_id_idx").on(table.githubId),
    index("pull_requests_repo_id_merged_at_idx").on(table.repoId, table.mergedAt),
    index("pull_requests_author_id_idx").on(table.authorId),
    check("pull_requests_state_check", sql`${table.state} in ('open', 'closed')`),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    githubId: integer("github_id").notNull(),
    prId: integer("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    reviewerId: integer("reviewer_id")
      .notNull()
      .references(() => users.id),
    state: text("state", { enum: reviewStates }).notNull(),
    submittedAt: integer("submitted_at").notNull(),
    bodyLen: integer("body_len").notNull(),
    commentCount: integer("comment_count").notNull(),
  },
  (table) => [
    uniqueIndex("reviews_github_id_idx").on(table.githubId),
    index("reviews_pr_id_idx").on(table.prId),
    index("reviews_reviewer_id_idx").on(table.reviewerId),
    check(
      "reviews_state_check",
      sql`${table.state} in ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED')`,
    ),
  ],
);

export const reviewComments = sqliteTable(
  "review_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    githubId: integer("github_id").notNull(),
    prId: integer("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    reviewerId: integer("reviewer_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("review_comments_github_id_idx").on(table.githubId),
    index("review_comments_pr_id_idx").on(table.prId),
    index("review_comments_reviewer_id_idx").on(table.reviewerId),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    since: integer("since").notNull(),
    until: integer("until").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    prCount: integer("pr_count"),
    status: text("status", { enum: syncStatuses }).notNull(),
  },
  (table) => [
    index("sync_runs_repo_id_idx").on(table.repoId),
    check("sync_runs_status_check", sql`${table.status} in ('running', 'succeeded', 'failed')`),
  ],
);

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type ReviewComment = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
