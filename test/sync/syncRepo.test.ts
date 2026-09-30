import { describe, expect, it, vi } from "vitest";
import { openDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import {
  pullRequests,
  repos,
  reviewComments,
  reviews,
  syncRuns,
  users,
} from "../../src/db/schema.js";
import { GHOST_ACTOR, type GitHubClient } from "../../src/github/index.js";
import { syncRepo } from "../../src/sync/index.js";

const LIST = "GET /repos/{owner}/{repo}/pulls";
const DETAIL = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const COMMITS = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
const TIMELINE = "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline";
const REVIEW_LIST = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const COMMENT_LIST = "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments";

const SINCE = Date.parse("2023-11-01T00:00:00Z") / 1000;
const UNTIL = Date.parse("2023-11-30T23:59:59Z") / 1000;
const CREATED = "2023-11-15T00:00:00Z";
const UPDATED = "2023-11-20T00:00:00Z";
const COMMITTED = "2023-11-18T12:00:00Z";

type RawUser = { id: number; login: string; type: string };

type Scenario = {
  listed: Record<string, unknown>[];
  details: Record<number, Record<string, unknown>>;
  commits: Record<number, unknown[]>;
  reviews: Record<number, unknown[]>;
  comments: Record<number, unknown[]>;
  failOn?: "list" | "reviews";
};

function migrated(): DbClient {
  const client = openDatabase(":memory:");
  migrateDatabase(client.db);
  return client;
}

function user(id: number, login: string, type = "User"): RawUser {
  return { id, login, type };
}

function listedPull(number: number, updatedAt = UPDATED): Record<string, unknown> {
  return {
    number,
    updated_at: updatedAt,
    created_at: CREATED,
    closed_at: null,
    merged_at: null,
  };
}

function detail(
  number: number,
  author: RawUser,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000 + number,
    number,
    state: "open",
    created_at: CREATED,
    closed_at: null,
    merged_at: null,
    additions: 120,
    deletions: 4,
    changed_files: 3,
    user: author,
    ...overrides,
  };
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    listed: [listedPull(7)],
    details: { 7: detail(7, user(1, "ada")) },
    commits: { 7: [{ commit: { committer: { date: COMMITTED } } }] },
    reviews: {
      7: [
        {
          id: 200,
          state: "COMMENTED",
          submitted_at: "2023-11-19T00:00:00Z",
          body: "nit",
          user: user(2, "grace"),
        },
      ],
    },
    comments: {
      7: [
        {
          id: 300,
          pull_request_review_id: 200,
          created_at: "2023-11-19T00:01:00Z",
          user: user(2, "grace"),
        },
      ],
    },
    ...overrides,
  };
}

function github(data: Scenario): GitHubClient {
  return {
    request: vi.fn(async (route: string, parameters: Record<string, unknown> = {}) => {
      if (data.failOn === "list")
        throw Object.assign(new Error("GitHub unavailable"), { statusCode: 503 });
      if (route === LIST) return data.listed;
      if (route === DETAIL) {
        const number = Number(parameters.pull_number);
        const row = data.details[number];
        if (!row) throw new Error(`missing pull #${number}`);
        return row;
      }
      throw new Error(`unexpected route ${route}`);
    }),
    paginate: vi.fn(async (route: string, parameters: Record<string, unknown> = {}) => {
      const number = Number(parameters.pull_number);
      if (route === COMMITS) return data.commits[number] ?? [];
      if (route === TIMELINE) return []; // pulls phase; no ready-for-review events in these fixtures
      if (data.failOn === "reviews") {
        throw Object.assign(new Error("reviews failed"), { statusCode: 503 });
      }
      if (route === REVIEW_LIST) return data.reviews[number] ?? [];
      if (route === COMMENT_LIST) return data.comments[number] ?? [];
      throw new Error(`unexpected route ${route}`);
    }),
  };
}

function counts(client: DbClient) {
  return {
    repos: client.db.select().from(repos).all().length,
    users: client.db.select().from(users).all().length,
    pullRequests: client.db.select().from(pullRequests).all().length,
    reviews: client.db.select().from(reviews).all().length,
    reviewComments: client.db.select().from(reviewComments).all().length,
    syncRuns: client.db.select().from(syncRuns).all().length,
  };
}

describe("syncRepo", () => {
  it("upserts the same window twice without duplicating users, PRs, reviews, or comments", async () => {
    const client = migrated();
    const data = scenario();
    const query = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };
    const now = vi.fn(() => 1_700_200_000);

    const first = await syncRepo(github(data), client.db, query, { now });
    const afterFirst = counts(client);

    data.details[7] = detail(7, user(1, "ada-renamed"), {
      state: "closed",
      closed_at: "2023-11-21T00:00:00Z",
      merged_at: "2023-11-21T00:00:00Z",
      additions: 140,
    });
    data.reviews[7] = [
      {
        id: 200,
        state: "APPROVED",
        submitted_at: "2023-11-19T01:00:00Z",
        body: "LGTM now",
        user: user(2, "grace"),
      },
    ];

    const second = await syncRepo(github(data), client.db, query, { now });

    expect(second).toEqual(first);
    expect(counts(client)).toEqual({ ...afterFirst, syncRuns: afterFirst.syncRuns + 1 });

    const storedUsers = client.db.select().from(users).all();
    expect(storedUsers).toEqual([
      expect.objectContaining({ githubId: 1, login: "ada-renamed", isBot: false }),
      expect.objectContaining({ githubId: 2, login: "grace", isBot: false }),
    ]);
    expect(client.db.select().from(pullRequests).all()).toEqual([
      expect.objectContaining({
        githubId: 1007,
        number: 7,
        state: "closed",
        additions: 140,
        mergedAt: Date.parse("2023-11-21T00:00:00Z") / 1000,
        lastCommitAt: Date.parse(COMMITTED) / 1000,
      }),
    ]);
    expect(client.db.select().from(reviews).all()).toEqual([
      expect.objectContaining({
        githubId: 200,
        state: "APPROVED",
        bodyLen: "LGTM now".length,
        commentCount: 1,
        submittedAt: Date.parse("2023-11-19T01:00:00Z") / 1000,
      }),
    ]);
    expect(client.db.select().from(reviewComments).all()).toHaveLength(1);
    client.close();
  });

  it("records the window, counts, and succeeded status on sync_runs", async () => {
    const client = migrated();
    const data = scenario({
      reviews: {
        7: [
          {
            id: 200,
            state: "APPROVED",
            submitted_at: "2023-11-19T00:00:00Z",
            body: "",
            user: user(2, "dependabot[bot]", "Bot"),
          },
        ],
      },
      comments: { 7: [] },
    });
    const ticks = [1_700_200_000, 1_700_200_030];
    const now = () => {
      const next = ticks.shift();
      if (next === undefined) throw new Error("clock exhausted");
      return next;
    };

    const result = await syncRepo(
      github(data),
      client.db,
      { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
      { now },
    );

    expect(result).toEqual({
      prCount: 1,
      reviewCount: 1,
      commentCount: 0,
      window: { since: SINCE, until: UNTIL },
      status: "succeeded",
    });
    expect(client.db.select().from(syncRuns).all()).toEqual([
      expect.objectContaining({
        since: SINCE,
        until: UNTIL,
        startedAt: 1_700_200_000,
        finishedAt: 1_700_200_030,
        prCount: 1,
        status: "succeeded",
      }),
    ]);
    expect(client.db.select().from(users).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ githubId: 2, login: "dependabot[bot]", isBot: true }),
      ]),
    );
    client.close();
  });

  it("handles a recycled login without aborting the run or merging the accounts", async () => {
    // First sync stores account 1 under login "ada". Then account 1 renames away
    // and a different account (github id 9) claims "ada". Syncing a window with
    // account 9 must not abort on the users.login unique index: account 9 takes
    // "ada", the stale account 1 is stashed under a per-account sentinel, and both
    // stay distinct rows.
    const client = migrated();
    const query = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };
    await syncRepo(github(scenario()), client.db, query, { now: () => 1_700_200_000 });

    const recycled = scenario({
      listed: [listedPull(8)],
      details: { 8: detail(8, user(3, "linus")) },
      commits: { 8: [{ commit: { committer: { date: COMMITTED } } }] },
      reviews: {
        8: [
          {
            id: 201,
            state: "APPROVED",
            submitted_at: "2023-11-19T00:00:00Z",
            body: "ship",
            user: user(9, "ada"),
          },
        ],
      },
      comments: { 8: [] },
    });

    const result = await syncRepo(github(recycled), client.db, query, {
      now: () => 1_700_200_100,
    });

    expect(result.status).toBe("succeeded");
    // The window synced fully: both PRs present, the review by account 9 stored.
    expect(
      client.db
        .select()
        .from(pullRequests)
        .all()
        .map((row) => row.number)
        .sort((a, b) => a - b),
    ).toEqual([7, 8]);
    expect(client.db.select().from(reviews).all()).toHaveLength(2);

    const usersByGithubId = new Map(
      client.db
        .select()
        .from(users)
        .all()
        .map((row) => [row.githubId, row]),
    );
    // Account 9 now owns "ada"; account 1 keeps its own row under a sentinel login
    // (no merge), and the sentinel is not a login GitHub could ever issue.
    expect(usersByGithubId.get(9)?.login).toBe("ada");
    expect(usersByGithubId.get(1)?.login).toBe("renamed:1");
    expect(usersByGithubId.get(1)?.login).toContain(":");
    expect(usersByGithubId.size).toBe(4);
    client.close();
  });

  it("self-heals a stashed account when it is next synced under its current login", async () => {
    const client = migrated();
    const query = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };
    await syncRepo(github(scenario()), client.db, query, { now: () => 1_700_200_000 });

    // Account 9 recycles "ada", stashing account 1.
    const recycled = scenario({
      listed: [listedPull(8)],
      details: { 8: detail(8, user(3, "linus")) },
      commits: { 8: [{ commit: { committer: { date: COMMITTED } } }] },
      reviews: {
        8: [
          {
            id: 201,
            state: "APPROVED",
            submitted_at: "2023-11-19T00:00:00Z",
            body: "ship",
            user: user(9, "ada"),
          },
        ],
      },
      comments: { 8: [] },
    });
    await syncRepo(github(recycled), client.db, query, { now: () => 1_700_200_100 });

    // A later window sees account 1 again under its current login.
    const renamed = scenario({
      listed: [listedPull(9)],
      details: { 9: detail(9, user(1, "ada-prime")) },
      commits: { 9: [{ commit: { committer: { date: COMMITTED } } }] },
      reviews: { 9: [] },
      comments: { 9: [] },
    });
    await syncRepo(github(renamed), client.db, query, { now: () => 1_700_200_200 });

    const usersByGithubId = new Map(
      client.db
        .select()
        .from(users)
        .all()
        .map((row) => [row.githubId, row.login]),
    );
    expect(usersByGithubId.get(1)).toBe("ada-prime");
    expect(usersByGithubId.get(9)).toBe("ada");
    client.close();
  });

  it("stores a deleted review author as ghost and still succeeds", async () => {
    const client = migrated();
    const data = scenario({
      reviews: {
        7: [
          {
            id: 191056424,
            state: "COMMENTED",
            submitted_at: "2023-11-19T00:00:00Z",
            body: "",
            user: null,
          },
        ],
      },
      comments: { 7: [] },
    });

    const result = await syncRepo(github(data), client.db, {
      owner: "acme",
      repo: "widgets",
      since: SINCE,
      until: UNTIL,
    });

    expect(result.status).toBe("succeeded");
    expect(result.reviewCount).toBe(1);
    expect(client.db.select().from(users).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          githubId: GHOST_ACTOR.githubId,
          login: GHOST_ACTOR.login,
          isBot: false,
        }),
      ]),
    );
    expect(client.db.select().from(reviews).all()).toEqual([
      expect.objectContaining({ githubId: 191056424, commentCount: 0 }),
    ]);
    client.close();
  });

  it("writes nothing when a fetch fails", async () => {
    const client = migrated();
    const query = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };

    await expect(
      syncRepo(github(scenario({ failOn: "reviews" })), client.db, query),
    ).rejects.toThrow(/reviews failed/);

    expect(counts(client)).toEqual({
      repos: 0,
      users: 0,
      pullRequests: 0,
      reviews: 0,
      reviewComments: 0,
      syncRuns: 0,
    });
    client.close();
  });
});
