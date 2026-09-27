import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { openDatabase, type AppDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { pullRequests, repos, reviews, syncRuns, users } from "../../src/db/schema.js";
import { DEFAULT_METRIC_WINDOW_SECONDS } from "../../src/metrics/loaders.js";
import { insightsGraphResponseSchema } from "../../src/schemas/insights.js";

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
  },
): number {
  const row = db
    .insert(pullRequests)
    .values({
      repoId: values.repoId,
      githubId: values.githubId,
      number: values.number,
      authorId: values.authorId,
      state: "open",
      createdAt: values.createdAt,
      readyAt: values.createdAt + 10,
      mergedAt: null,
      closedAt: null,
      additions: 180,
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
  values: { githubId: number; prId: number; reviewerId: number; submittedAt: number },
): void {
  db.insert(reviews)
    .values({
      githubId: values.githubId,
      prId: values.prId,
      reviewerId: values.reviewerId,
      state: "APPROVED",
      submittedAt: values.submittedAt,
      bodyLen: 0,
      commentCount: 0,
    })
    .run();
}

function insertSync(db: AppDatabase, repoId: number, since: number, until: number): void {
  db.insert(syncRuns)
    .values({
      repoId,
      since,
      until,
      startedAt: since,
      finishedAt: until,
      prCount: 1,
      status: "succeeded",
    })
    .run();
}

/** Three grace → ada reviews and no reverse edge. Weight meets the flag threshold. */
function seedOneWay(db: AppDatabase, since = SINCE, until = UNTIL): void {
  const repoId = insertRepo(db);
  const ada = insertUser(db, 1, "ada");
  const grace = insertUser(db, 2, "grace");
  for (const number of [1, 2, 3]) {
    const prId = insertPull(db, {
      repoId,
      githubId: 100 + number,
      number,
      authorId: ada,
      createdAt: since + number * 100,
    });
    insertReview(db, {
      githubId: 200 + number,
      prId,
      reviewerId: grace,
      submittedAt: since + number * 100 + 50,
    });
  }
  insertSync(db, repoId, since, until);
}

/** Three reviews each way. Mutual, so neither edge is one-directional. */
function seedMutual(db: AppDatabase): void {
  const repoId = insertRepo(db);
  const ada = insertUser(db, 1, "ada");
  const grace = insertUser(db, 2, "grace");
  for (const number of [1, 2, 3]) {
    const adaPr = insertPull(db, {
      repoId,
      githubId: 100 + number,
      number,
      authorId: ada,
      createdAt: SINCE + number * 100,
    });
    insertReview(db, {
      githubId: 200 + number,
      prId: adaPr,
      reviewerId: grace,
      submittedAt: SINCE + number * 100 + 20,
    });
    const gracePr = insertPull(db, {
      repoId,
      githubId: 300 + number,
      number: number + 10,
      authorId: grace,
      createdAt: SINCE + number * 100 + 30,
    });
    insertReview(db, {
      githubId: 400 + number,
      prId: gracePr,
      reviewerId: ada,
      submittedAt: SINCE + number * 100 + 40,
    });
  }
  insertSync(db, repoId, SINCE, UNTIL);
}

async function getGraph(client: DbClient, url: string, now?: () => number) {
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

describe("GET /insights/graph", () => {
  it("returns the frontend node and edge shape, with a one-way edge flagged", async () => {
    const client = migrated();
    seedOneWay(client.db);

    const response = await getGraph(
      client,
      `/insights/graph?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      nodes: [
        { id: "ada", label: "ada", reviewsGiven: 0, reviewsReceived: 3 },
        { id: "grace", label: "grace", reviewsGiven: 3, reviewsReceived: 0 },
      ],
      edges: [{ source: "grace", target: "ada", weight: 3, flagged: true }],
    });
    expect(insightsGraphResponseSchema.parse(body)).toEqual(body);
    expect(JSON.stringify(body)).not.toMatch(/githubId|reciprocityScore|reverseWeight|ratio/);
    expect(JSON.stringify(body)).not.toContain(testConfig.githubToken);
    client.close();
  });

  it("does not flag a mutual pair", async () => {
    const client = migrated();
    seedMutual(client.db);

    const response = await getGraph(
      client,
      `/insights/graph?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      nodes: [
        { id: "ada", label: "ada", reviewsGiven: 3, reviewsReceived: 3 },
        { id: "grace", label: "grace", reviewsGiven: 3, reviewsReceived: 3 },
      ],
      edges: [
        { source: "ada", target: "grace", weight: 3, flagged: false },
        { source: "grace", target: "ada", weight: 3, flagged: false },
      ],
    });
    client.close();
  });

  it("uses the default last-30-day window when since and until are omitted", async () => {
    const client = migrated();
    const nowSeconds = 1_700_000_000;
    seedOneWay(client.db, nowSeconds - DEFAULT_METRIC_WINDOW_SECONDS, nowSeconds);

    const response = await getGraph(client, "/insights/graph?owner=acme&repo=widgets", () => {
      return nowSeconds * 1000;
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().edges).toEqual([
      { source: "grace", target: "ada", weight: 3, flagged: true },
    ]);
    client.close();
  });

  it("returns an empty graph for a synced window with no review edges", async () => {
    const client = migrated();
    const repoId = insertRepo(client.db);
    insertSync(client.db, repoId, SINCE, UNTIL);

    const response = await getGraph(
      client,
      `/insights/graph?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nodes: [], edges: [] });
    client.close();
  });

  it("returns 404 for an unknown repo and 409 when the window is not covered", async () => {
    const missing = migrated();
    const missingResponse = await getGraph(missing, "/insights/graph?owner=acme&repo=widgets");
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Repository acme/widgets not found",
    });
    missing.close();

    const unsynced = migrated();
    insertRepo(unsynced.db);
    const unsyncedResponse = await getGraph(
      unsynced,
      `/insights/graph?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    );
    expect(unsyncedResponse.statusCode).toBe(409);
    expect(unsyncedResponse.json()).toEqual({
      status: 409,
      error: "Conflict",
      message: `No synced data for acme/widgets between ${SINCE} and ${UNTIL}. POST /sync with this owner, repo, since, and until first.`,
    });
    unsynced.close();
  });

  it("returns 400 for a bad owner", async () => {
    const client = migrated();
    const response = await getGraph(client, "/insights/graph?owner=acme/widgets&repo=widgets");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "owner: must match ^[A-Za-z0-9_.-]+$",
    });
    client.close();
  });
});
