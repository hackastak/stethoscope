import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { pullRequests, repos, reviewComments, reviews, users } from "../../src/db/schema.js";
import { DEFAULT_METRIC_WINDOW_SECONDS, loadMetricWindow } from "../../src/metrics/loaders.js";

const SINCE = 1_700_000_000;
const UNTIL = 1_700_086_400;

function migrated(): DbClient {
  const client = openDatabase(":memory:");
  migrateDatabase(client.db);
  return client;
}

function insertRepo(db: AppDatabase, owner: string, name: string): number {
  const row = db.insert(repos).values({ owner, name }).returning({ id: repos.id }).get();
  if (!row) throw new Error("repo insert failed");
  return row.id;
}

function insertUser(db: AppDatabase, githubId: number, login: string, isBot = false): number {
  const row = db.insert(users).values({ githubId, login, isBot }).returning({ id: users.id }).get();
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
    closedAt?: number | null;
    mergedAt?: number | null;
    readyAt?: number | null;
    lastCommitAt?: number | null;
    state?: "open" | "closed";
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
      state: values.state ?? (values.closedAt || values.mergedAt ? "closed" : "open"),
      createdAt: values.createdAt,
      readyAt: values.readyAt ?? null,
      mergedAt: values.mergedAt ?? null,
      closedAt: values.closedAt ?? null,
      additions: values.additions ?? 10,
      deletions: 1,
      changedFiles: 1,
      lastCommitAt: values.lastCommitAt ?? values.createdAt,
    })
    .returning({ id: pullRequests.id })
    .get();
  if (!row) throw new Error("pull insert failed");
  return row.id;
}

function queryCount(db: AppDatabase, run: () => void): number {
  const sqlite = (db as AppDatabase & { $client: Database.Database }).$client;
  let count = 0;
  const original = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((source: string) => {
    count += 1;
    return original(source);
  }) as typeof sqlite.prepare;
  try {
    run();
  } finally {
    sqlite.prepare = original as typeof sqlite.prepare;
  }
  return count;
}

describe("loadMetricWindow", () => {
  it("returns window-overlapping PRs with reviews and comments attached", () => {
    const client = migrated();
    const repoId = insertRepo(client.db, "acme", "widgets");
    const ada = insertUser(client.db, 1, "ada");
    const grace = insertUser(client.db, 2, "grace");
    const outsideId = insertPull(client.db, {
      repoId,
      githubId: 900,
      number: 1,
      authorId: ada,
      createdAt: SINCE - 10_000,
      closedAt: SINCE - 1,
      mergedAt: SINCE - 1,
    });
    const openId = insertPull(client.db, {
      repoId,
      githubId: 901,
      number: 9,
      authorId: ada,
      createdAt: SINCE - 50,
      readyAt: SINCE - 40,
      lastCommitAt: SINCE + 10,
      additions: 40,
    });
    const mergedId = insertPull(client.db, {
      repoId,
      githubId: 902,
      number: 4,
      authorId: grace,
      createdAt: SINCE + 100,
      closedAt: UNTIL,
      mergedAt: UNTIL,
      readyAt: SINCE + 120,
      lastCommitAt: SINCE + 200,
      additions: 80,
    });
    client.db
      .insert(reviews)
      .values([
        {
          githubId: 1,
          prId: outsideId,
          reviewerId: grace,
          state: "APPROVED",
          submittedAt: SINCE - 20,
          bodyLen: 4,
          commentCount: 0,
        },
        {
          githubId: 2,
          prId: openId,
          reviewerId: grace,
          state: "COMMENTED",
          submittedAt: SINCE - 5,
          bodyLen: 20,
          commentCount: 1,
        },
        {
          githubId: 3,
          prId: mergedId,
          reviewerId: ada,
          state: "APPROVED",
          submittedAt: SINCE + 300,
          bodyLen: 2,
          commentCount: 0,
        },
      ])
      .run();
    client.db
      .insert(reviewComments)
      .values([
        { githubId: 10, prId: openId, reviewerId: grace, createdAt: SINCE + 1 },
        { githubId: 11, prId: mergedId, reviewerId: ada, createdAt: SINCE + 250 },
        { githubId: 12, prId: outsideId, reviewerId: grace, createdAt: SINCE - 30 },
      ])
      .run();

    const window = loadMetricWindow(client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });

    expect(window.repo).toEqual({ id: repoId, owner: "acme", name: "widgets" });
    expect(window.since).toBe(SINCE);
    expect(window.until).toBe(UNTIL);
    expect(window.pullRequests.map((pull) => pull.number)).toEqual([4, 9]);
    expect(window.pullRequests[1]).toMatchObject({
      githubId: 901,
      author: { githubId: 1, login: "ada" },
      additions: 40,
      readyAt: SINCE - 40,
      reviews: [
        {
          githubId: 2,
          state: "COMMENTED",
          submittedAt: SINCE - 5,
          bodyLen: 20,
          commentCount: 1,
          reviewer: { githubId: 2, login: "grace" },
        },
      ],
      comments: [{ githubId: 10, createdAt: SINCE + 1, reviewer: { login: "grace" } }],
    });
    expect(window.pullRequests[0]?.reviews).toEqual([
      expect.objectContaining({
        githubId: 3,
        state: "APPROVED",
        reviewer: { id: ada, githubId: 1, login: "ada" },
      }),
    ]);
    expect(window.users).toEqual([
      { id: ada, githubId: 1, login: "ada" },
      { id: grace, githubId: 2, login: "grace" },
    ]);
    client.close();
  });

  it("keeps an ongoing PR and a PR whose close falls on the window edge", () => {
    const client = migrated();
    const repoId = insertRepo(client.db, "acme", "widgets");
    const ada = insertUser(client.db, 1, "ada");
    insertPull(client.db, {
      repoId,
      githubId: 1,
      number: 2,
      authorId: ada,
      createdAt: UNTIL,
    });
    insertPull(client.db, {
      repoId,
      githubId: 2,
      number: 3,
      authorId: ada,
      createdAt: SINCE - 100,
      closedAt: SINCE,
      mergedAt: null,
    });
    insertPull(client.db, {
      repoId,
      githubId: 3,
      number: 4,
      authorId: ada,
      createdAt: UNTIL + 1,
    });
    insertPull(client.db, {
      repoId,
      githubId: 4,
      number: 5,
      authorId: ada,
      createdAt: SINCE - 100,
      closedAt: SINCE - 1,
      mergedAt: SINCE + 10,
    });

    const window = loadMetricWindow(client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });

    expect(window.pullRequests.map((pull) => pull.number)).toEqual([2, 3]);
    client.close();
  });

  it("excludes bot authors, bot reviews, and bot comments", () => {
    const client = migrated();
    const repoId = insertRepo(client.db, "acme", "widgets");
    const ada = insertUser(client.db, 1, "ada");
    const bot = insertUser(client.db, 9, "renovate[bot]", true);
    const humanPr = insertPull(client.db, {
      repoId,
      githubId: 1,
      number: 1,
      authorId: ada,
      createdAt: SINCE,
    });
    const botPr = insertPull(client.db, {
      repoId,
      githubId: 2,
      number: 2,
      authorId: bot,
      createdAt: SINCE,
    });
    client.db
      .insert(reviews)
      .values([
        {
          githubId: 21,
          prId: humanPr,
          reviewerId: bot,
          state: "APPROVED",
          submittedAt: SINCE + 5,
          bodyLen: 0,
          commentCount: 0,
        },
        {
          githubId: 22,
          prId: botPr,
          reviewerId: ada,
          state: "COMMENTED",
          submittedAt: SINCE + 6,
          bodyLen: 3,
          commentCount: 0,
        },
      ])
      .run();
    client.db
      .insert(reviewComments)
      .values([
        { githubId: 31, prId: humanPr, reviewerId: bot, createdAt: SINCE + 7 },
        { githubId: 32, prId: botPr, reviewerId: ada, createdAt: SINCE + 8 },
      ])
      .run();

    const window = loadMetricWindow(client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });

    expect(window.pullRequests).toEqual([
      expect.objectContaining({
        number: 1,
        author: { id: ada, githubId: 1, login: "ada" },
        reviews: [],
        comments: [],
      }),
    ]);
    expect(window.users).toEqual([{ id: ada, githubId: 1, login: "ada" }]);
    client.close();
  });

  it("does not include another repository", () => {
    const client = migrated();
    const widgets = insertRepo(client.db, "acme", "widgets");
    const other = insertRepo(client.db, "acme", "other");
    const ada = insertUser(client.db, 1, "ada");
    insertPull(client.db, {
      repoId: widgets,
      githubId: 1,
      number: 1,
      authorId: ada,
      createdAt: SINCE,
    });
    insertPull(client.db, {
      repoId: other,
      githubId: 2,
      number: 1,
      authorId: ada,
      createdAt: SINCE,
    });

    const window = loadMetricWindow(client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });

    expect(window.pullRequests).toHaveLength(1);
    expect(window.pullRequests[0]?.githubId).toBe(1);
    client.close();
  });

  it("returns an empty window for a known repo with no overlapping PRs", () => {
    const client = migrated();
    insertRepo(client.db, "acme", "widgets");

    expect(
      loadMetricWindow(client.db, {
        owner: "acme",
        repo: "widgets",
        since: SINCE,
        until: UNTIL,
      }).pullRequests,
    ).toEqual([]);
    client.close();
  });

  it("maps an unknown repo to 404 and a bad window to 400", () => {
    const client = migrated();
    insertRepo(client.db, "acme", "widgets");

    expect(() =>
      loadMetricWindow(client.db, {
        owner: "acme",
        repo: "missing",
        since: SINCE,
        until: UNTIL,
      }),
    ).toThrowError(
      expect.objectContaining({ statusCode: 404, message: "Repository acme/missing not found" }),
    );
    expect(() =>
      loadMetricWindow(client.db, {
        owner: "acme",
        repo: "widgets",
        since: UNTIL,
        until: SINCE,
      }),
    ).toThrowError(
      expect.objectContaining({ statusCode: 400, message: "until must be on or after since" }),
    );
    client.close();
  });

  it("defaults until to now when it is omitted", () => {
    const client = migrated();
    const repoId = insertRepo(client.db, "acme", "widgets");
    const ada = insertUser(client.db, 1, "ada");
    const now = SINCE + 500;
    insertPull(client.db, {
      repoId,
      githubId: 1,
      number: 1,
      authorId: ada,
      createdAt: now,
    });
    insertPull(client.db, {
      repoId,
      githubId: 2,
      number: 2,
      authorId: ada,
      createdAt: now + 1,
    });

    const window = loadMetricWindow(
      client.db,
      { owner: "acme", repo: "widgets", since: SINCE },
      { now: () => now * 1000 },
    );

    expect(window.until).toBe(now);
    expect(window.pullRequests.map((pull) => pull.number)).toEqual([1]);
    client.close();
  });

  it("defaults since to 30 days before now when it is omitted", () => {
    const client = migrated();
    const repoId = insertRepo(client.db, "acme", "widgets");
    const ada = insertUser(client.db, 1, "ada");
    const now = SINCE + DEFAULT_METRIC_WINDOW_SECONDS;
    const since = now - DEFAULT_METRIC_WINDOW_SECONDS;
    insertPull(client.db, {
      repoId,
      githubId: 1,
      number: 1,
      authorId: ada,
      createdAt: since - 10,
      closedAt: since - 1,
      mergedAt: since - 1,
    });
    insertPull(client.db, {
      repoId,
      githubId: 2,
      number: 2,
      authorId: ada,
      createdAt: since,
    });

    const window = loadMetricWindow(
      client.db,
      { owner: "acme", repo: "widgets" },
      { now: () => now * 1000 },
    );

    expect(window.since).toBe(since);
    expect(window.until).toBe(now);
    expect(DEFAULT_METRIC_WINDOW_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(window.pullRequests.map((pull) => pull.number)).toEqual([2]);
    client.close();
  });

  it("uses the same bounded query count for one PR and many PRs", () => {
    function seeded(pullCount: number): DbClient {
      const client = migrated();
      const repoId = insertRepo(client.db, "acme", "widgets");
      const author = insertUser(client.db, 1, "ada");
      const reviewer = insertUser(client.db, 2, "grace");
      for (let number = 1; number <= pullCount; number += 1) {
        const prId = insertPull(client.db, {
          repoId,
          githubId: 100 + number,
          number,
          authorId: author,
          createdAt: SINCE,
        });
        client.db
          .insert(reviews)
          .values({
            githubId: 200 + number,
            prId,
            reviewerId: reviewer,
            state: "APPROVED",
            submittedAt: SINCE + number,
            bodyLen: 1,
            commentCount: 0,
          })
          .run();
        client.db
          .insert(reviewComments)
          .values({
            githubId: 300 + number,
            prId,
            reviewerId: reviewer,
            createdAt: SINCE + number,
          })
          .run();
      }
      return client;
    }

    const one = seeded(1);
    const many = seeded(8);
    const query = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };
    const oneCount = queryCount(one.db, () => loadMetricWindow(one.db, query));
    const manyCount = queryCount(many.db, () => loadMetricWindow(many.db, query));

    expect(loadMetricWindow(many.db, query).pullRequests).toHaveLength(8);
    expect(oneCount).toBe(manyCount);
    expect(manyCount).toBeLessThanOrEqual(6);
    one.close();
    many.close();
  });
});
