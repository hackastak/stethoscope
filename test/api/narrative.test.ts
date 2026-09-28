import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { openDatabase, type AppDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { pullRequests, repos, reviews, syncRuns, users } from "../../src/db/schema.js";
import { LlmOutputError, LlmRequestError, type LLMProvider } from "../../src/llm/provider.js";
import { narrativeResponseSchema } from "../../src/schemas/narrative.js";

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
const DAY = 24 * 60 * 60;

type Script = {
  narrative?: string;
  hypothesis?: string | null;
  confidence?: number;
  evidence: string[];
};

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

/** One open pull request and one non-self review. Grace's review count is 1. Ada authored 1. */
function seedSynced(db: AppDatabase, since = SINCE, until = UNTIL): void {
  const repoId = insertRepo(db);
  const ada = insertUser(db, 1, "ada");
  const grace = insertUser(db, 2, "grace");
  const pull = db
    .insert(pullRequests)
    .values({
      repoId,
      githubId: 101,
      number: 7,
      authorId: ada,
      state: "open",
      createdAt: since + 100,
      readyAt: since + 110,
      additions: 12,
      deletions: 3,
      changedFiles: 1,
    })
    .returning({ id: pullRequests.id })
    .get();
  if (!pull) throw new Error("pull insert failed");
  db.insert(reviews)
    .values({
      githubId: 201,
      prId: pull.id,
      reviewerId: grace,
      state: "COMMENTED",
      submittedAt: since + 200,
      bodyLen: 40,
      commentCount: 1,
    })
    .run();
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

function scriptedProvider(
  script: Script | Script[],
): LLMProvider & { calls: number; prompts: string[] } {
  const steps = Array.isArray(script) ? script : [script];
  const prompts: string[] = [];
  return {
    prompts,
    get calls() {
      return prompts.length;
    },
    async complete(prompt, schema) {
      prompts.push(prompt);
      const step = steps[prompts.length - 1] ?? steps[steps.length - 1];
      if (!step) throw new Error("unexpected provider call");
      const output = {
        narrative: step.narrative ?? "Grace submitted one review.",
        hypothesis:
          step.hypothesis === undefined ? "Review work sits with one person." : step.hypothesis,
        confidence: step.confidence ?? 0.4,
        evidence: step.evidence,
      };
      const parsed = schema.safeParse(output);
      if (!parsed.success)
        throw new LlmOutputError("Narrative completion failed schema validation");
      return parsed.data;
    },
  };
}

describe("POST /narrative", () => {
  it("returns a narrative whose evidence ids resolve to the insight facts", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider = scriptedProvider({
      evidence: ["fact:leaderboard:reviewers:grace", "fact:cycletime:first_review_p50"],
    });
    const app = await buildApp({ config: testConfig, logger: false, db: client.db, llm: provider });

    const response = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
    });
    const insights = await app.inject({
      method: "GET",
      url: `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
    });
    const body = response.json();
    const facts = insights.json().facts as { id: string; value: number | null }[];

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/json/);
    expect(narrativeResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      window: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
      narrative: "Grace submitted one review.",
      hypothesis: "Review work sits with one person.",
      confidence: 0.4,
      evidence: [
        { id: "fact:leaderboard:reviewers:grace", value: 1 },
        { id: "fact:cycletime:first_review_p50", value: null },
      ],
    });
    expect(facts.find((fact) => fact.id === "fact:leaderboard:reviewers:grace")?.value).toBe(1);
    expect(facts.find((fact) => fact.id === "fact:cycletime:first_review_p50")?.value).toBeNull();
    expect(provider.calls).toBe(1);
    expect(provider.prompts[0]).toContain("fact:leaderboard:reviewers:grace");
    expect(JSON.stringify(body)).not.toContain(testConfig.anthropicApiKey);

    await app.close();
    client.close();
  });

  it("uses the default last-30-day window when since and until are omitted", async () => {
    const client = migrated();
    const nowSeconds = 1_700_000_000;
    const since = nowSeconds - 30 * DAY;
    seedSynced(client.db, since, nowSeconds);
    const provider = scriptedProvider({ evidence: ["fact:leaderboard:reviewers:grace"] });
    const app = await buildApp({
      config: testConfig,
      logger: false,
      db: client.db,
      llm: provider,
      now: () => nowSeconds * 1000,
    });

    const response = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      window: { owner: "acme", repo: "widgets", since, until: nowSeconds },
      evidence: [{ id: "fact:leaderboard:reviewers:grace", value: 1 }],
    });

    await app.close();
    client.close();
  });

  it("returns the same 404 and 409 as /insights and does not call the provider", async () => {
    const provider = scriptedProvider({ evidence: [] });
    const missing = migrated();
    const missingApp = await buildApp({
      config: testConfig,
      logger: false,
      db: missing.db,
      llm: provider,
    });
    const missingResponse = await missingApp.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets" },
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Repository acme/widgets not found",
    });
    await missingApp.close();
    missing.close();

    const unsynced = migrated();
    insertRepo(unsynced.db);
    const unsyncedApp = await buildApp({
      config: testConfig,
      logger: false,
      db: unsynced.db,
      llm: provider,
    });
    const unsyncedResponse = await unsyncedApp.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
    });
    expect(unsyncedResponse.statusCode).toBe(409);
    expect(unsyncedResponse.json()).toEqual({
      status: 409,
      error: "Conflict",
      message: `No synced data for acme/widgets between ${SINCE} and ${UNTIL}. POST /sync with this owner, repo, since, and until first.`,
    });
    expect(provider.calls).toBe(0);
    await unsyncedApp.close();
    unsynced.close();
  });

  it("rate-limits per IP and does not limit /insights", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider = scriptedProvider({ evidence: ["fact:leaderboard:reviewers:grace"] });
    const now = () => 1_700_000_000_000;
    const app = await buildApp({
      config: testConfig,
      logger: false,
      db: client.db,
      llm: provider,
      now,
      narrativeRateLimit: { max: 1, windowMs: 60_000 },
    });
    const payload = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };

    const first = await app.inject({
      method: "POST",
      url: "/narrative",
      payload,
      remoteAddress: "10.0.0.1",
    });
    const second = await app.inject({
      method: "POST",
      url: "/narrative",
      payload,
      remoteAddress: "10.0.0.1",
    });
    const otherIp = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { ...payload, until: UNTIL - 1 },
      remoteAddress: "10.0.0.2",
    });
    const insights = await app.inject({
      method: "GET",
      url: `/insights?owner=acme&repo=widgets&since=${SINCE}&until=${UNTIL}`,
      remoteAddress: "10.0.0.1",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
    expect(second.json()).toEqual({
      status: 429,
      error: "Too Many Requests",
      message:
        "Too many narrative requests from this IP. Limit is 1 per 60 seconds. Retry after 60 seconds.",
    });
    expect(otherIp.statusCode).toBe(200);
    expect(insights.statusCode).toBe(200);
    expect(provider.calls).toBe(2);

    await app.close();
    client.close();
  });

  it("applies a default limit of 10 requests per 60 seconds", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider = scriptedProvider({ evidence: [] });
    const app = await buildApp({
      config: testConfig,
      logger: false,
      db: client.db,
      llm: provider,
      now: () => 1_700_000_000_000,
    });
    const payload = { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/narrative", payload });
      statuses.push(response.statusCode);
    }
    const blocked = await app.inject({ method: "POST", url: "/narrative", payload });

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toContain("Limit is 10 per 60 seconds");
    expect(provider.calls).toBe(1);

    await app.close();
    client.close();
  });

  it("does not return a narrative that cites an unknown fact id", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider = scriptedProvider([
      { narrative: "Invented a person.", evidence: ["fact:invented:nope"] },
      { narrative: "Invented a person again.", evidence: ["fact:invented:nope"] },
    ]);
    const app = await buildApp({ config: testConfig, logger: false, db: client.db, llm: provider });

    const response = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      status: 502,
      error: "Bad Gateway",
      message: "Narrative cited unknown fact ids: fact:invented:nope",
    });
    expect(JSON.stringify(response.json())).not.toContain("Invented a person");
    expect(provider.calls).toBe(2);

    await app.close();
    client.close();
  });

  it("redacts the LLM key from a provider failure", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider: LLMProvider = {
      async complete() {
        throw new LlmRequestError(
          `LLM request failed (401): invalid ${testConfig.anthropicApiKey}`,
        );
      },
    };
    const app = await buildApp({ config: testConfig, logger: false, db: client.db, llm: provider });

    const response = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since: SINCE, until: UNTIL },
    });
    const body = response.json() as { message: string };

    expect(response.statusCode).toBe(502);
    expect(body.message).toContain("[REDACTED]");
    expect(body.message).not.toContain(testConfig.anthropicApiKey);

    await app.close();
    client.close();
  });

  it("returns 400 field errors and does not call the provider", async () => {
    const client = migrated();
    seedSynced(client.db);
    const provider = scriptedProvider({ evidence: [] });
    const app = await buildApp({ config: testConfig, logger: false, db: client.db, llm: provider });

    const owner = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme/widgets", repo: "widgets" },
    });
    const date = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since: "" },
    });
    const extra = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", model: "other-model" },
    });

    expect(owner.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "owner: must match ^[A-Za-z0-9_.-]+$",
    });
    expect(date.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "since: must be an ISO-8601 date or unix epoch seconds",
    });
    expect(extra.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "body: unrecognized key model",
    });
    expect(provider.calls).toBe(0);

    await app.close();
    client.close();
  });

  it("accepts ISO-8601 and digit-string bounds", async () => {
    const client = migrated();
    const since = "2023-11-14T00:00:00Z";
    const until = "2023-11-15T00:00:00Z";
    const sinceSeconds = Math.floor(Date.parse(since) / 1000);
    const untilSeconds = Math.floor(Date.parse(until) / 1000);
    seedSynced(client.db, sinceSeconds, untilSeconds);
    const provider = scriptedProvider({ evidence: [], hypothesis: null, confidence: 0 });
    const app = await buildApp({ config: testConfig, logger: false, db: client.db, llm: provider });

    const iso = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets", since, until },
    });
    const digits = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: {
        owner: "acme",
        repo: "widgets",
        since: String(sinceSeconds),
        until: String(untilSeconds),
      },
    });

    expect(iso.statusCode).toBe(200);
    expect(iso.json()).toMatchObject({
      window: { since: sinceSeconds, until: untilSeconds },
      hypothesis: null,
      confidence: 0,
      evidence: [],
    });
    expect(digits.statusCode).toBe(200);
    expect(digits.json().window).toEqual({
      owner: "acme",
      repo: "widgets",
      since: sinceSeconds,
      until: untilSeconds,
    });

    await app.close();
    client.close();
  });

  it("is not registered without a provider", async () => {
    const client = migrated();
    const app = await buildApp({ config: testConfig, logger: false, db: client.db });

    const response = await app.inject({
      method: "POST",
      url: "/narrative",
      payload: { owner: "acme", repo: "widgets" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Route POST /narrative not found",
    });

    await app.close();
    client.close();
  });
});
