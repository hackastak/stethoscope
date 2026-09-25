import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import type { GitHubClient } from "../../src/github/client.js";

const USER_REPOS = "GET /user/repos";
const USERS_REPOS = "GET /users/{username}/repos";

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

function raw(name: string, owner: string, pushedAt: string, visibility = "public") {
  return {
    name,
    full_name: `${owner}/${name}`,
    private: visibility !== "public",
    visibility,
    default_branch: "main",
    pushed_at: pushedAt,
    owner: { login: owner },
  };
}

function github(mode: "ok" | "unauthorized" = "ok"): GitHubClient {
  return {
    request: vi.fn(),
    paginate: vi.fn(async (route: string) => {
      if (mode === "unauthorized") {
        throw Object.assign(new Error(`Bad credentials ${testConfig.githubToken}`), {
          statusCode: 401,
        });
      }
      if (route === USER_REPOS) {
        return [
          raw("older", "ada", "2024-01-01T00:00:00Z", "private"),
          raw("newer", "ada", "2024-05-01T00:00:00Z"),
        ];
      }
      if (route === USERS_REPOS) {
        return [
          raw("secret", "someuser", "2024-06-01T00:00:00Z", "private"),
          raw("open", "someuser", "2024-02-01T00:00:00Z"),
        ];
      }
      throw new Error(`unexpected route ${route}`);
    }),
  };
}

describe("GET /repos", () => {
  it("returns the token owner's repos sorted by pushedAt desc", async () => {
    const app = await buildApp({ config: testConfig, logger: false, github: github() });

    const response = await app.inject({ method: "GET", url: "/repos" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        owner: "ada",
        name: "newer",
        fullName: "ada/newer",
        visibility: "public",
        defaultBranch: "main",
        pushedAt: Date.parse("2024-05-01T00:00:00Z") / 1000,
      },
      {
        owner: "ada",
        name: "older",
        fullName: "ada/older",
        visibility: "private",
        defaultBranch: "main",
        pushedAt: Date.parse("2024-01-01T00:00:00Z") / 1000,
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain(testConfig.githubToken);
    await app.close();
  });

  it("returns a user's public repos for ?owner=", async () => {
    const app = await buildApp({ config: testConfig, logger: false, github: github() });

    const response = await app.inject({ method: "GET", url: "/repos?owner=someuser" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        owner: "someuser",
        name: "open",
        fullName: "someuser/open",
        visibility: "public",
        defaultBranch: "main",
        pushedAt: Date.parse("2024-02-01T00:00:00Z") / 1000,
      },
    ]);
    await app.close();
  });

  it("returns 400 for an invalid owner", async () => {
    const app = await buildApp({ config: testConfig, logger: false, github: github() });

    const response = await app.inject({ method: "GET", url: "/repos?owner=acme/widgets" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: 400,
      error: "Bad Request",
      message: "owner: must match ^[A-Za-z0-9_.-]+$",
    });
    await app.close();
  });

  it("maps a bad token to 401 and keeps the token out of the body and logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const app = await buildApp({
      config: testConfig,
      logStream: stream,
      github: github("unauthorized"),
    });

    const response = await app.inject({ method: "GET", url: "/repos" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      status: 401,
      error: "Unauthorized",
      message: "Bad credentials [REDACTED]",
    });
    expect(response.body).not.toContain(testConfig.githubToken);
    expect(chunks.join("")).not.toContain(testConfig.githubToken);
    await app.close();
  });

  it("is not registered without a GitHub client, and does not replace sync", async () => {
    const bare = await buildApp({ config: testConfig, logger: false });
    const missing = await bare.inject({ method: "GET", url: "/repos" });
    expect(missing.statusCode).toBe(404);
    await bare.close();

    const app = await buildApp({ config: testConfig, logger: false, github: github() });
    const sync = await app.inject({ method: "POST", url: "/sync", payload: {} });
    expect(sync.statusCode).toBe(404);
    await app.close();
  });
});
