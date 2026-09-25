import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { createGitHubClient } from "../../src/github/index.js";

const TOKEN = "ghp_super_secret_token";

function config(): Config {
  return loadConfig({
    GITHUB_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: "sk-ant-test",
  });
}

type MockResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function jsonResponse(result: MockResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "content-type": "application/json",
      ...result.headers,
    },
  });
}

describe("createGitHubClient", () => {
  const consoleSpies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends the config token and never logs it", async () => {
    const warnings: string[] = [];
    let authorization = "";
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? "";
      return jsonResponse({ status: 200, body: { ok: true } });
    });

    const client = createGitHubClient(config(), {
      fetch,
      log: {
        warn: (message) => warnings.push(message),
      },
    });

    await client.request("GET /user");

    expect(authorization).toContain(TOKEN);
    expect(warnings.join("\n")).not.toContain(TOKEN);
    for (const spy of Object.values(consoleSpies)) {
      const dumped = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(dumped).not.toContain(TOKEN);
    }
  });

  it("maps an unknown repo to 404 without echoing the token", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        status: 404,
        body: { message: `Not Found ${TOKEN}` },
      }),
    );
    const client = createGitHubClient(config(), { fetch });

    const error = await client
      .request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "missing" })
      .then(() => {
        throw new Error("expected a 404");
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      statusCode: 404,
      message: "Repository octocat/missing not found",
    });
    expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
  });

  it("retries a secondary rate limit using retry-after, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          status: 403,
          body: { message: "You have exceeded a secondary rate limit." },
          headers: {
            "retry-after": "2",
            "x-ratelimit-remaining": "40",
          },
        });
      }
      return jsonResponse({ status: 200, body: { id: 7 } });
    });
    const client = createGitHubClient(config(), {
      fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.request("GET /user")).resolves.toEqual({ id: 7 });
    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it("caps secondary-rate-limit retries and delay", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse({
        status: 403,
        body: { message: `secondary rate limit ${TOKEN}` },
        headers: {
          "retry-after": "120",
          "x-ratelimit-remaining": "10",
        },
      });
    });
    const client = createGitHubClient(config(), {
      fetch,
      maxRetries: 3,
      maxBackoffMs: 60_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const error = await client.request("GET /user").then(
      () => {
        throw new Error("expected rate limit error");
      },
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      statusCode: 429,
      message: "GitHub rate limit exceeded. Retry after 60 seconds.",
    });
    expect(calls).toBe(4);
    expect(delays).toEqual([60_000, 60_000, 60_000]);
    expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
  });

  it("waits until x-ratelimit-reset when the primary quota is exhausted", async () => {
    const now = 1_700_000_000_000;
    const delays: number[] = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          status: 403,
          body: { message: "API rate limit exceeded for user." },
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(now / 1000) + 12),
          },
        });
      }
      return jsonResponse({ status: 200, body: { ok: true } });
    });
    const client = createGitHubClient(config(), {
      fetch,
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.request("GET /user")).resolves.toEqual({ ok: true });
    expect(delays).toEqual([12_000]);
  });

  it("does not retry a non-rate-limit 403", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn(async () =>
      jsonResponse({
        status: 403,
        body: { message: "Resource not accessible by integration" },
        headers: { "x-ratelimit-remaining": "4999" },
      }),
    );
    const client = createGitHubClient(config(), { fetch, sleep });

    await expect(client.request("GET /user")).rejects.toMatchObject({
      statusCode: 403,
      message: "Resource not accessible by integration",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("paginates until the next link disappears and does not mutate parameters", async () => {
    const parameters = { owner: "octocat", repo: "hello", state: "all" };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("page=2")) {
        return jsonResponse({
          status: 200,
          body: [{ number: 1 }],
          headers: {
            link: '<https://api.github.com/repos/octocat/hello/pulls?page=2>; rel="next"',
          },
        });
      }
      return jsonResponse({ status: 200, body: [{ number: 2 }] });
    });
    const client = createGitHubClient(config(), { fetch });

    await expect(client.paginate("GET /repos/{owner}/{repo}/pulls", parameters)).resolves.toEqual([
      { number: 1 },
      { number: 2 },
    ]);
    expect(parameters).toEqual({ owner: "octocat", repo: "hello", state: "all" });
    expect(fetch.mock.calls.length).toBe(2);
  });

  it("stops pagination at the page cap", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        status: 200,
        body: [{ number: 1 }],
        headers: {
          link: '<https://api.github.com/repos/octocat/hello/pulls?page=2>; rel="next"',
        },
      }),
    );
    const client = createGitHubClient(config(), { fetch, maxPages: 2 });

    await expect(
      client.paginate("GET /repos/{owner}/{repo}/pulls", { owner: "octocat", repo: "hello" }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "GitHub pagination exceeded the page cap",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
