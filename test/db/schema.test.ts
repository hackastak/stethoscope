import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import {
  pullRequests,
  repos,
  reviewComments,
  reviews,
  syncRuns,
  users,
  type PullRequest,
  type Review,
  type ReviewComment,
} from "../../src/db/schema.js";
import type { Config } from "../../src/config.js";
import { startServer } from "../../src/server.js";

const tempDirs: string[] = [];

function fileDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "stethoscope-schema-"));
  tempDirs.push(dir);
  return path.join(dir, "stethoscope.sqlite");
}

function migratedClient(databasePath = ":memory:"): DbClient {
  const client = openDatabase(databasePath);
  migrateDatabase(client.db);
  return client;
}

type IndexRow = { name: string; tbl_name: string; sql: string | null };

function indexes(client: DbClient): IndexRow[] {
  return client.db.all<IndexRow>(
    sql`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'`,
  );
}

function tableNames(client: DbClient): string[] {
  const rows = client.db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateDatabase", () => {
  it("creates tables and hot-path indexes, and is idempotent", () => {
    const client = migratedClient();

    expect(tableNames(client)).toEqual([
      "__drizzle_migrations",
      "pull_requests",
      "repos",
      "review_comments",
      "reviews",
      "sync_runs",
      "users",
    ]);

    const indexRows = indexes(client);
    expect(indexRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pull_requests_repo_id_merged_at_idx",
          tbl_name: "pull_requests",
        }),
        expect.objectContaining({ name: "reviews_pr_id_idx", tbl_name: "reviews" }),
        expect.objectContaining({ name: "reviews_reviewer_id_idx", tbl_name: "reviews" }),
      ]),
    );

    const repo = client.db
      .insert(repos)
      .values({ owner: "acme", name: "widgets" })
      .returning()
      .get();

    migrateDatabase(client.db);

    expect(tableNames(client)).toEqual([
      "__drizzle_migrations",
      "pull_requests",
      "repos",
      "review_comments",
      "reviews",
      "sync_runs",
      "users",
    ]);
    expect(client.db.select().from(repos).all()).toEqual([repo]);
    expect(
      client.db.all<{ count: number }>(sql`SELECT count(*) as count FROM __drizzle_migrations`),
    ).toEqual([{ count: 1 }]);

    client.close();
  });

  it("inserts a PR, review, and comment when foreign keys hold, and rejects orphans", () => {
    const client = migratedClient();

    const repo = client.db
      .insert(repos)
      .values({ owner: "acme", name: "widgets" })
      .returning()
      .get();
    const author = client.db
      .insert(users)
      .values({ githubId: 10, login: "ada", isBot: false })
      .returning()
      .get();
    const reviewer = client.db
      .insert(users)
      .values({ githubId: 11, login: "grace", isBot: false })
      .returning()
      .get();

    const pullRequest: PullRequest = client.db
      .insert(pullRequests)
      .values({
        repoId: repo.id,
        githubId: 100,
        number: 7,
        authorId: author.id,
        state: "closed",
        createdAt: 1_700_000_000,
        readyAt: 1_700_000_100,
        mergedAt: 1_700_003_000,
        closedAt: 1_700_003_000,
        additions: 120,
        deletions: 4,
        changedFiles: 3,
        lastCommitAt: 1_700_001_000,
      })
      .returning()
      .get();

    const review: Review = client.db
      .insert(reviews)
      .values({
        githubId: 200,
        prId: pullRequest.id,
        reviewerId: reviewer.id,
        state: "APPROVED",
        submittedAt: 1_700_002_000,
        bodyLen: 12,
        commentCount: 1,
      })
      .returning()
      .get();

    const comment: ReviewComment = client.db
      .insert(reviewComments)
      .values({
        githubId: 300,
        prId: pullRequest.id,
        reviewerId: reviewer.id,
        createdAt: 1_700_001_500,
      })
      .returning()
      .get();

    const syncRun = client.db
      .insert(syncRuns)
      .values({
        repoId: repo.id,
        since: 1_699_000_000,
        until: 1_700_100_000,
        startedAt: 1_700_004_000,
        finishedAt: 1_700_004_010,
        prCount: 1,
        status: "succeeded",
      })
      .returning()
      .get();

    expect(pullRequest.number).toBe(7);
    expect(review.state).toBe("APPROVED");
    expect(comment.reviewerId).toBe(reviewer.id);
    expect(syncRun.prCount).toBe(1);

    expect(() =>
      client.db
        .insert(reviews)
        .values({
          githubId: 201,
          prId: 999,
          reviewerId: reviewer.id,
          state: "COMMENTED",
          submittedAt: 1_700_002_100,
          bodyLen: 0,
          commentCount: 0,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    expect(() =>
      client.db
        .insert(reviewComments)
        .values({
          githubId: 301,
          prId: pullRequest.id,
          reviewerId: 999,
          createdAt: 1_700_001_600,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    expect(() =>
      client.db
        .insert(reviews)
        .values({
          githubId: 202,
          prId: pullRequest.id,
          reviewerId: reviewer.id,
          state: "PENDING" as "APPROVED",
          submittedAt: 1_700_002_200,
          bodyLen: 0,
          commentCount: 0,
        })
        .run(),
    ).toThrow(/CHECK/i);

    client.close();
  });
});

describe("startServer", () => {
  it("runs migrations on boot", async () => {
    const databasePath = fileDatabasePath();
    const config: Config = Object.freeze({
      githubToken: "ghp_test_token_aaa",
      anthropicApiKey: "sk-ant-test_key_bbb",
      llmModel: "claude-sonnet-5",
      port: 0,
      databasePath,
      fastApprovalSeconds: 300,
      minPrSize: 100,
      minReciprocityInteractions: 3,
    });

    const app = await startServer(config);
    try {
      const client = openDatabase(databasePath);
      expect(tableNames(client)).toContain("pull_requests");
      expect(tableNames(client)).toContain("reviews");
      client.close();
    } finally {
      await app.close();
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
    }
  });
});
