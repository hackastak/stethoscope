import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { openDatabase, type DbClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { pullRequests, repos, syncRuns } from "../../src/db/schema.js";
import type { GitHubClient } from "../../src/github/client.js";

const LIST = "GET /repos/{owner}/{repo}/pulls";
const DETAIL = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const COMMITS = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
const REVIEW_LIST = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const COMMENT_LIST = "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments";

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

function migrated(): DbClient {
  const client = openDatabase(":memory:");
  migrateDatabase(client.db);
  return client;
}

function github(mode: "ok" | "missing"): GitHubClient {
  return {
    request: vi.fn(async (route: string) => {
      if (mode === "missing") {
        throw Object.assign(new Error("Repository acme/missing not found"), { statusCode: 404 });
      }
      if (route === LIST) {
        return [
          {
            number: 7,
            updated_at: "2023-11-20T00:00:00Z",
            created_at: "2023-11-15T00:00:00Z",
            closed_at: null,
            merged_at: null,
          },
        ];
      }
      if (route === DETAIL) {
        return {
          id: 1007,
          number: 7,
          state: "open",
          created_at: "2023-11-15T00:00:00Z",
          closed_at: null,
          merged_at: null,
          additions: 120,
          deletions: 4,
          changed_files: 3,
          user: { id: 1, login: "ada", type: "User" },
        };
      }
      throw new Error(`unexpected route ${route}`);
    }),
    paginate: vi.fn(async (route: string) => {
      if (route === COMMITS) {
        return [{ commit: { committer: { date: "2023-11-18T12:00:00Z" } } }];
      }
      if (route === REVIEW_LIST) {
        return [
          {
            id: 200,
            state: "APPROVED",
            submitted_at: "2023-11-19T00:00:00Z",
            body: "LGTM",
            user: { id: 2, login: "grace", type: "User" },
          },
        ];
      }
      if (route === COMMENT_LIST) return [];
      throw new Error(`unexpected route ${route}`);
    }),
  };
}

async function postSync(client: DbClient, body: unknown, mode: "ok" | "missing" = "ok") {
  const app = await buildApp({
    config: testConfig,
    logger: false,
    db: client.db,
    github: github(mode),
  });
  const response = await app.inject({ method: "POST", url: "/sync", payload: body });
  await app.close();
  return response;
}

describe("POST /sync", () => {
  it("returns a 200 summary and populates the database", async () => {
    const client = migrated();
    const since = Date.parse("2023-11-01T00:00:00Z") / 1000;
    const until = Date.parse("2023-11-30T23:59:59Z") / 1000;

    const response = await postSync(client, {
      owner: "acme",
      repo: "widgets",
      since: "2023-11-01T00:00:00Z",
      until,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prCount: 1,
      reviewCount: 1,
      window: { since, until },
    });
    expect(client.db.select().from(repos).all()).toEqual([
      expect.objectContaining({ owner: "acme", name: "widgets" }),
    ]);
    expect(client.db.select().from(pullRequests).all()).toHaveLength(1);
    expect(client.db.select().from(syncRuns).all()).toEqual([
      expect.objectContaining({ since, until, prCount: 1, status: "succeeded" }),
    ]);
    client.close();
  });

  it("returns 400 with a field-level message for an invalid owner or date", async () => {
    const client = migrated();

    const owner = await postSync(client, {
      owner: "acme/widgets",
      repo: "widgets",
      since: "2023-11-01",
      until: "2023-11-30",
    });
    const date = await postSync(client, {
      owner: "acme",
      repo: "widgets",
      since: "yesterday",
      until: "2023-11-30T00:00:00Z",
    });
    const order = await postSync(client, {
      owner: "acme",
      repo: "widgets",
      since: "2023-12-01T00:00:00Z",
      until: "2023-11-01T00:00:00Z",
    });

    expect(owner.statusCode).toBe(400);
    expect(owner.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "owner: must match ^[A-Za-z0-9_.-]+$",
    });
    expect(date.statusCode).toBe(400);
    expect(date.json()).toMatchObject({
      status: 400,
      error: "Bad Request",
    });
    expect((date.json() as { message: string }).message).toMatch(/since:/);
    expect(order.statusCode).toBe(400);
    expect((order.json() as { message: string }).message).toMatch(
      /until: must be on or after since/,
    );
    expect(client.db.select().from(pullRequests).all()).toHaveLength(0);
    client.close();
  });

  it("returns 404 when the repository is unknown", async () => {
    const client = migrated();

    const response = await postSync(
      client,
      {
        owner: "acme",
        repo: "missing",
        since: "2023-11-01T00:00:00Z",
        until: "2023-11-30T00:00:00Z",
      },
      "missing",
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Repository acme/missing not found",
    });
    expect(client.db.select().from(repos).all()).toHaveLength(0);
    expect(client.db.select().from(syncRuns).all()).toHaveLength(0);
    client.close();
  });
});
