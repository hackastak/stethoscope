import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { openDatabase, type AppDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { pullRequests, repos, reviews, syncRuns, users } from "../../src/db/schema.js";
import { buildFacts } from "../../src/facts/build.js";
import { computeCycleTime } from "../../src/metrics/cycletime.js";
import { buildLeaderboards } from "../../src/metrics/leaderboards.js";
import { computeLoadBalance } from "../../src/metrics/loadbalance.js";
import { DEFAULT_METRIC_WINDOW_SECONDS, loadMetricWindow } from "../../src/metrics/loaders.js";
import { buildReciprocityGraph } from "../../src/metrics/reciprocity.js";
import { detectRubberStamps } from "../../src/metrics/rubberstamp.js";
import { insightsResponseSchema } from "../../src/schemas/insights.js";

const testConfig: Config = Object.freeze({
  githubToken: "ghp_test_token_aaa",
  anthropicApiKey: "sk-ant-test_key_bbb",
  llmModel: "claude-sonnet-5",
  port: 3000,
  databasePath: ":memory:",
  fastApprovalSeconds: 300,
  minPrSize: 100,
  minReciprocityInteractions: 3,
});

const SINCE = 1_700_000_000;
const UNTIL = 1_700_086_400;

function migrated(): DbClient {
  const client = openDatabase(":memory:");
  migrateDatabase(client.db);
  return client;
}

function insertRepo(db: AppDatabase, owner = "acme", name = "widgets"): number {
  const row = db.insert(repos).values({ owner, name }).returning({ id: repos.id }).get();
  if (!row) throw new Error("repo insert failed");
  return row.id;
}

function insertUser(db: AppDatabase, githubId: number, login: string): number {
  const row = db
    .insert(users)
    .values({ githubId, login, isBot: false })
    .returning({ id: users.id })
    .get();
  if (!row) throw new Error("user insert failed");
  return row.id;
}

function insertPull(
  db: AppDatabase,
  values: {
    repoId: number;
    githubId: number;
    number: number;
    authorId: number;
    createdAt: number;
    mergedAt?: number | null;
    additions?: number;
  },
): number {
  const row = db
    .insert(pullRequests)
    .values({
      repoId: values.repoId,
      githubId: values.githubId,
      number: values.number,
      authorId: values.authorId,
      state: values.mergedAt ? "closed" : "open",
      createdAt: values.createdAt,
      readyAt: values.createdAt + 10,
      mergedAt: values.mergedAt ?? null,
      closedAt: values.mergedAt ?? null,
      additions: values.additions ?? 180,
      deletions: 40,
      changedFiles: 4,
      lastCommitAt: values.createdAt + 20,
    })
    .returning({ id: pullRequests.id })
    .get();
  if (!row) throw new Error("pull insert failed");
  return row.id;
}

function insertReview(
  db: AppDatabase,
  values: {
    githubId: number;
    prId: number;
    reviewerId: number;
    submittedAt: number;
    state?: "APPROVED" | "COMMENTED";
  },
): void {
  db.insert(reviews)
    .values({
      githubId: values.githubId,
      prId: values.prId,
      reviewerId: values.reviewerId,
      state: values.state ?? "APPROVED",
      submittedAt: values.submittedAt,
      bodyLen: 0,
      commentCount: 0,
    })
    .run();
}

function insertSync(
  db: AppDatabase,
  repoId: number,
  since: number,
  until: number,
  status: "succeeded" | "failed" | "running" = "succeeded",
): void {
  db.insert(syncRuns)
    .values({
      repoId,
      since,
      until,
      startedAt: since,
      finishedAt: status === "running" ? null : until,
      prCount: status === "succeeded" ? 1 : null,
      status,
    })
    .run();
}

/** Three grace→ada reviews, one fast silent approval on a large merged PR. */
function seedSynced(db: AppDatabase, since = SINCE, until = UNTIL): void {
  const repoId = insertRepo(db);
  const ada = insertUser(db, 1, "ada");
  const grace = insertUser(db, 2, "grace");
  const merged = insertPull(db, {
    repoId,
    githubId: 101,
    number: 1,
    authorId: ada,
    createdAt: since + 100,
    mergedAt: since + 1_000,
  });
  const commented = insertPull(db, {
    repoId,
    githubId: 102,
    number: 2,
    authorId: ada,
    createdAt: since + 200,
  });
  const slow = insertPull(db, {
    repoId,
    githubId: 103,
    number: 3,
    authorId: ada,
    createdAt: since + 300,
  });
  insertReview(db, { githubId: 201, prId: merged, reviewerId: grace, submittedAt: since + 150 });
  insertReview(db, {
    githubId: 202,
    prId: commented,
    reviewerId: grace,
    submittedAt: since + 250,
    state: "COMMENTED",
  });
  insertReview(db, { githubId: 203, prId: slow, reviewerId: grace, submittedAt: since + 2_000 });
  insertSync(db, repoId, since, until);
}

async function getInsights(client: DbClient, url: string, now?: () => number) {
  const app = await buildApp({
    config: testConfig,
    logger: false,
    db: client.db,
    now,
  });
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("GET /insights", () => {
  it("returns facts and tables for a synced window, validated by the response schema", async () => {
    const client = migrated();
    seedSynced(client.db);

    const response = await getInsights(
      client,
      `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    const body = response.json();

    const metricWindow = loadMetricWindow(client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });
    const reciprocity = buildReciprocityGraph(metricWindow, { minInteractions: 3 });
    const rubberStamp = detectRubberStamps(metricWindow, {
      fastApprovalSeconds: 300,
      minPrSize: 100,
    });
    const cycleTime = computeCycleTime(metricWindow);
    const leaderboards = buildLeaderboards(metricWindow);
    const facts = buildFacts({
      reciprocity,
      rubberStamp,
      cycleTime,
      loadBalance: computeLoadBalance(metricWindow),
      leaderboards,
    });

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      window: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
      facts,
      leaderboards,
      cycleTime,
      rubberStamp,
      reciprocitySummary: {
        minInteractions: 3,
        nodeCount: 2,
        edgeCount: 1,
        flaggedEdgeCount: 1,
        flaggedEdges: [{ source: "grace", target: "ada", weight: 3, reverseWeight: 0 }],
      },
    });
    expect(insightsResponseSchema.parse(body)).toEqual(body);
    expect(facts.some((fact) => fact.id === "fact:rubberstamp:grace" && fact.value === 0.5)).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toContain(testConfig.githubToken);
    client.close();
  });

  it("echoes the default last-30-day window when since and until are omitted", async () => {
    const client = migrated();
    const nowSeconds = 1_700_000_000;
    const since = nowSeconds - DEFAULT_METRIC_WINDOW_SECONDS;
    seedSynced(client.db, since, nowSeconds);

    const response = await getInsights(
      client,
      "/insights?owner=acme&repo=widgets",
      () => nowSeconds * 1000,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        window: { owner: "acme", repo: "widgets", since, until: nowSeconds },
      }),
    );
    client.close();
  });

  it("returns an empty synced window instead of treating zero pull requests as unsynced", async () => {
    const client = migrated();
    const repoId = insertRepo(client.db);
    insertSync(client.db, repoId, SINCE, UNTIL);

    const response = await getInsights(
      client,
      `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    const body = response.json() as { facts: { id: string; value: number | null }[] };

    expect(response.statusCode).toBe(200);
    expect(insightsResponseSchema.parse(body)).toEqual(body);
    expect(
      body.facts.find((fact) => fact.id === "fact:cycletime:first_review_p50")?.value,
    ).toBeNull();
    client.close();
  });

  it("returns 404 for an unknown repo and 409 when a known repo's window is not covered", async () => {
    const missing = migrated();
    const missingResponse = await getInsights(missing, "/insights?owner=acme&repo=widgets");
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Repository acme/widgets not found",
    });
    missing.close();

    const unsynced = migrated();
    insertRepo(unsynced.db);
    const unsyncedResponse = await getInsights(
      unsynced,
      `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    expect(unsyncedResponse.statusCode).toBe(409);
    expect(unsyncedResponse.json()).toEqual({
      status: 409,
      error: "Conflict",
      message: `No synced data for acme/widgets between ${SINCE} and ${UNTIL}. POST /sync with this owner, repo, since, and until first.`,
    });
    unsynced.close();

    const failed = migrated();
    insertSync(failed.db, insertRepo(failed.db), SINCE, UNTIL, "failed");
    const failedResponse = await getInsights(
      failed,
      `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    expect(failedResponse.statusCode).toBe(409);
    expect(failedResponse.json().message).toContain("POST /sync");
    failed.close();

    const narrow = migrated();
    insertSync(narrow.db, insertRepo(narrow.db), SINCE, UNTIL - 1);
    const narrowResponse = await getInsights(
      narrow,
      `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    expect(narrowResponse.statusCode).toBe(409);
    expect(narrowResponse.json().message).not.toMatch(/stack|500/i);
    narrow.close();
  });

  it("returns 400 for a bad owner, date, or bound order", async () => {
    const client = migrated();

    const owner = await getInsights(client, "/insights?owner=acme/widgets&repo=widgets");
    const date = await getInsights(client, "/insights?owner=acme&repo=widgets&since=yesterday");
    const order = await getInsights(
      client,
      `/insights?owner=acme&repo=widgets&since=${UNTIL}&until=${SINCE}`,
    );

    expect(owner.statusCode).toBe(400);
    expect(owner.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "owner: must match ^[A-Za-z0-9_.-]+$",
    });
    expect(date.statusCode).toBe(400);
    expect(date.json().message).toBe("since: must be an ISO-8601 date or unix epoch seconds");
    expect(order.statusCode).toBe(400);
    expect(order.json().message).toBe("until: must be on or after since");
    client.close();
  });

  it("accepts an ISO date and a wider covering sync", async () => {
    const client = migrated();
    const since = Date.parse("2023-11-01T00:00:00Z") / 1000;
    const until = Date.parse("2023-11-02T00:00:00Z") / 1000;
    seedSynced(client.db, since - 100, until + 100);

    const response = await getInsights(
      client,
      "/insights?owner=acme&repo=widgets&since=2023-11-01&until=2023-11-02T00:00:00Z",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().window).toEqual({ owner: "acme", repo: "widgets", since, until });
    client.close();
  });
});
