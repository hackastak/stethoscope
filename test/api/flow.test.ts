import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { openDatabase, type AppDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import {
  pullRequests,
  repos,
  reviewComments,
  reviews,
  syncRuns,
  users,
} from "../../src/db/schema.js";
import { createGitHubClient } from "../../src/github/index.js";
import { LlmOutputError, type LLMProvider } from "../../src/llm/provider.js";
import {
  FIXTURE_OWNER,
  FIXTURE_REPO,
  FIXTURE_SINCE,
  FIXTURE_SINCE_ISO,
  FIXTURE_UNTIL,
  FIXTURE_UNTIL_ISO,
  expectedFactValues,
  listedPulls,
  normalizedUserRepos,
  pullComments,
  pullCommits,
  pullDetail,
  pullReviews,
  storedCommentCount,
  storedPullNumbers,
  storedReviewCount,
  storedUserCount,
  userRepos,
} from "../fixtures/github.js";

const TOKEN = "ghp_test_token_aaa";

const testConfig: Config = Object.freeze({
  githubToken: TOKEN,
  anthropicApiKey: "sk-ant-test_key_bbb",
  llmModel: "claude-sonnet-5",
  port: 3000,
  databasePath: ":memory:",
  fastApprovalSeconds: 300,
  minPrSize: 100,
  minReciprocityInteractions: 3,
});

const syncBody = {
  owner: FIXTURE_OWNER,
  repo: FIXTURE_REPO,
  since: FIXTURE_SINCE_ISO,
  until: FIXTURE_UNTIL_ISO,
};

type FixtureMode = "ok" | "unauthorized";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function pullNumber(pathname: string, suffix: string): number | undefined {
  const match = pathname.match(new RegExp(`^/repos/acme/widgets/pulls/(\\d+)${suffix}$`));
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

/**
 * Real Octokit, fixture HTTP. Page 2 is empty so a list that ignored `page` cannot loop.
 * An out-of-window pull that is still listed must not be enriched.
 */
function fixtureFetch(mode: FixtureMode): typeof fetch {
  return async (input) => {
    if (mode === "unauthorized") {
      return jsonResponse(401, { message: `Bad credentials ${TOKEN}` });
    }
    const url = requestUrl(input);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page > 1) return jsonResponse(200, []);

    if (url.pathname === "/user/repos") return jsonResponse(200, userRepos);
    if (url.pathname === "/repos/acme/widgets/pulls") return jsonResponse(200, listedPulls);

    const detail = pullNumber(url.pathname, "");
    if (detail !== undefined) {
      const body = pullDetail(detail);
      if (body === undefined) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, body);
    }
    const commits = pullNumber(url.pathname, "/commits");
    if (commits !== undefined) {
      const body = pullCommits(commits);
      if (!body) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, body);
    }
    const reviewPage = pullNumber(url.pathname, "/reviews");
    if (reviewPage !== undefined) {
      const body = pullReviews(reviewPage);
      if (!body) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, body);
    }
    const commentPage = pullNumber(url.pathname, "/comments");
    if (commentPage !== undefined) {
      const body = pullComments(commentPage);
      if (!body) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, body);
    }
    return jsonResponse(404, { message: `No fixture for ${url.pathname}` });
  };
}

function github(mode: FixtureMode = "ok") {
  return createGitHubClient(testConfig, { fetch: fixtureFetch(mode) });
}

function migrated(): DbClient {
  const client = openDatabase(":memory:");
  migrateDatabase(client.db);
  return client;
}

type Script = { narrative: string; evidence: string[] };

function scriptedProvider(steps: Script[]): LLMProvider & { calls: number } {
  const prompts: string[] = [];
  return {
    get calls() {
      return prompts.length;
    },
    async complete(prompt, schema) {
      prompts.push(prompt);
      const step = steps[prompts.length - 1] ?? steps[steps.length - 1];
      if (!step) throw new Error("unexpected provider call");
      const output = {
        narrative: step.narrative,
        hypothesis: null,
        confidence: 0.5,
        evidence: step.evidence,
      };
      const parsed = schema.safeParse(output);
      if (!parsed.success)
        throw new LlmOutputError("Narrative completion failed schema validation");
      return parsed.data;
    },
  };
}

function entityCounts(db: AppDatabase) {
  return {
    repos: db.select().from(repos).all().length,
    users: db.select().from(users).all().length,
    pullRequests: db.select().from(pullRequests).all().length,
    reviews: db.select().from(reviews).all().length,
    reviewComments: db.select().from(reviewComments).all().length,
    syncRuns: db.select().from(syncRuns).all().length,
  };
}

describe("fixture API flow", () => {
  it("syncs fixture GitHub data, returns those facts, and keeps entity rows stable on a second sync", async () => {
    const client = migrated();
    const provider = scriptedProvider([]);
    const app = await buildApp({
      config: testConfig,
      logger: false,
      db: client.db,
      github: github(),
      llm: provider,
    });
    const insightsUrl = `/insights?owner=${FIXTURE_OWNER}&repo=${FIXTURE_REPO}&since=${FIXTURE_SINCE}&until=${FIXTURE_UNTIL}`;

    const before = await app.inject({ method: "GET", url: insightsUrl });
    const synced = await app.inject({ method: "POST", url: "/sync", payload: syncBody });
    const insights = await app.inject({ method: "GET", url: insightsUrl });
    const afterFirst = entityCounts(client.db);
    const again = await app.inject({ method: "POST", url: "/sync", payload: syncBody });

    expect(before.statusCode).toBe(404);
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toEqual({
      prCount: storedPullNumbers.length,
      reviewCount: storedReviewCount,
      window: { since: FIXTURE_SINCE, until: FIXTURE_UNTIL },
    });
    expect(
      client.db
        .select()
        .from(pullRequests)
        .all()
        .map((row) => row.number)
        .sort((left, right) => left - right),
    ).toEqual(storedPullNumbers);
    expect(afterFirst.users).toBe(storedUserCount);
    expect(afterFirst.reviewComments).toBe(storedCommentCount);
    expect(afterFirst.syncRuns).toBe(1);

    expect(insights.statusCode).toBe(200);
    const facts = insights.json().facts as { id: string; value: number | null }[];
    expect(Object.fromEntries(facts.map((fact) => [fact.id, fact.value]))).toEqual(
      expectedFactValues,
    );
    expect(insights.json().reciprocitySummary).toMatchObject({
      flaggedEdgeCount: 1,
      flaggedEdges: [{ source: "grace", target: "ada", weight: 3, reverseWeight: 0 }],
    });
    expect(JSON.stringify(facts)).not.toContain("dependabot");
    expect(provider.calls).toBe(0);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(synced.json());
    expect(entityCounts(client.db)).toEqual({ ...afterFirst, syncRuns: 2 });
    expect(client.db.select().from(syncRuns).all()).toEqual([
      expect.objectContaining({ status: "succeeded", prCount: storedPullNumbers.length }),
      expect.objectContaining({ status: "succeeded", prCount: storedPullNumbers.length }),
    ]);

    await app.close();
    client.close();
  });

  it("returns normalized repos and maps a bad token to 401", async () => {
    const ok = await buildApp({ config: testConfig, logger: false, github: github() });
    const listed = await ok.inject({ method: "GET", url: "/repos" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(normalizedUserRepos);
    await ok.close();

    const denied = await buildApp({
      config: testConfig,
      logger: false,
      github: github("unauthorized"),
    });
    const response = await denied.inject({ method: "GET", url: "/repos" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401, error: "Unauthorized" });
    expect(response.body).not.toContain(TOKEN);
    await denied.close();
  });

  it("rejects a narrative that cites a fact id the fixture did not produce", async () => {
    const client = migrated();
    const provider = scriptedProvider([
      { narrative: "Invented a fourth reviewer.", evidence: ["fact:invented:nope"] },
      { narrative: "Invented a fourth reviewer again.", evidence: ["fact:invented:nope"] },
      {
        narrative: "Grace reviewed three of Ada's pull requests.",
        evidence: ["fact:reciprocity:grace->ada"],
      },
    ]);
    const app = await buildApp({
      config: testConfig,
      logger: false,
      db: client.db,
      github: github(),
      llm: provider,
    });

    const synced = await app.inject({ method: "POST", url: "/sync", payload: syncBody });
    const rejected = await app.inject({ method: "POST", url: "/narrative", payload: syncBody });
    const accepted = await app.inject({ method: "POST", url: "/narrative", payload: syncBody });

    expect(synced.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json()).toEqual({
      status: 502,
      error: "Bad Gateway",
      message: "Narrative cited unknown fact ids: fact:invented:nope",
    });
    expect(JSON.stringify(rejected.json())).not.toContain("Invented a fourth reviewer");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      narrative: "Grace reviewed three of Ada's pull requests.",
      evidence: [{ id: "fact:reciprocity:grace->ada", value: 3 }],
    });
    expect(provider.calls).toBe(3);

    await app.close();
    client.close();
  });
});
