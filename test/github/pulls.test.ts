import { describe, expect, it, vi } from "vitest";
import { GHOST_ACTOR, fetchPullRequests, type GitHubClient } from "../../src/github/index.js";

const SINCE = Date.parse("2023-11-01T00:00:00Z") / 1000;
const UNTIL = Date.parse("2023-11-30T23:59:59Z") / 1000;

type RouteHandler = (parameters: Record<string, unknown>) => unknown;

function client(handlers: Record<string, RouteHandler>): GitHubClient & {
  request: ReturnType<typeof vi.fn>;
  paginate: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (route: string, parameters: Record<string, unknown> = {}) => {
    const handler = handlers[route];
    if (handler) return handler(parameters);
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        id: parameters.pull_number,
        number: parameters.pull_number,
        state: "open",
        created_at: "2023-11-15T00:00:00Z",
        closed_at: null,
        merged_at: null,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        user: { id: 1, login: "octocat", type: "User" },
      };
    }
    throw new Error(`unexpected route ${route}`);
  });
  return {
    request,
    paginate: vi.fn(async () => [{ commit: { committer: { date: "2023-11-15T00:00:00Z" } } }]),
  };
}

/**
 * Route handler for the pulls list endpoint that serves separate page sets for
 * the `state=closed` and `state=open` passes the fetcher runs.
 */
function listHandler(pagesByState: {
  open?: unknown[][];
  closed?: unknown[][];
}): RouteHandler {
  return (parameters) => {
    const state = parameters.state as "open" | "closed";
    const pages = pagesByState[state] ?? [];
    const page = Number(parameters.page ?? 1);
    return pages[page - 1] ?? [];
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    number: 10,
    state: "closed",
    updated_at: "2023-11-15T00:00:00Z",
    created_at: "2023-11-15T00:00:00Z",
    closed_at: "2023-11-16T00:00:00Z",
    merged_at: "2023-11-16T00:00:00Z",
    user: { id: 1, login: "octocat", type: "User" },
    ...overrides,
  };
}

function open(overrides: Record<string, unknown> = {}) {
  return summary({ state: "open", closed_at: null, merged_at: null, ...overrides });
}

describe("fetchPullRequests", () => {
  it("scans closed newest-updated first and stops once updated_at is before since", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [
          [
            summary({
              id: 3,
              number: 3,
              updated_at: "2023-11-01T00:00:00Z",
              created_at: "2023-10-20T00:00:00Z",
              closed_at: "2023-11-18T00:00:00Z",
              merged_at: "2023-11-18T00:00:00Z",
            }),
            summary({
              id: 2,
              number: 2,
              updated_at: "2023-10-31T23:59:59Z",
              created_at: "2023-10-01T00:00:00Z",
              closed_at: "2023-10-02T00:00:00Z",
              merged_at: "2023-10-02T00:00:00Z",
            }),
          ],
          // A second page exists but must never be requested: the scan stops on
          // #2's pre-window update above.
          [summary({ id: 99, number: 99 })],
        ],
      }),
    });

    const pulls = await fetchPullRequests(
      github,
      { owner: "octocat", repo: "hello", since: SINCE, until: UNTIL },
      { perPage: 2 },
    );

    expect(pulls.map((pull) => pull.number)).toEqual([3]);

    const listCalls = github.request.mock.calls.filter(
      (call) => call[0] === "GET /repos/{owner}/{repo}/pulls",
    );
    // one closed page (stopped) + one open page (empty)
    expect(listCalls.map((call) => call[1]?.page)).toEqual([1, 1]);
    expect(github.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ state: "closed", sort: "updated", direction: "desc", page: 1 }),
    );
    expect(github.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ state: "open", sort: "created", direction: "asc", page: 1 }),
    );
  });

  it("includes a dormant open PR whose last update predates the window", async () => {
    // Regression: the old updated_at-desc `state=all` scan broke paging on the
    // first pre-window update and dropped still-open PRs whose lifetime is
    // [created, +infinity). #7 was opened and last touched before `since` yet is
    // still open across the window, so it overlaps and must be kept.
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        open: [
          [
            open({
              id: 7,
              number: 7,
              created_at: "2023-01-01T00:00:00Z",
              updated_at: "2023-02-01T00:00:00Z",
            }),
            // Created after the window: creation-ascending order puts it last and
            // stops the scan.
            open({
              id: 8,
              number: 8,
              created_at: "2023-12-15T00:00:00Z",
              updated_at: "2023-12-15T00:00:00Z",
            }),
          ],
        ],
      }),
    });

    const pulls = await fetchPullRequests(github, {
      owner: "octocat",
      repo: "hello",
      since: SINCE,
      until: UNTIL,
    });

    expect(pulls.map((pull) => pull.number)).toEqual([7]);
  });

  it("follows a full closed page inside the window and stops on a short page", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [
          [
            summary({ id: 1, number: 11, updated_at: "2023-11-20T00:00:00Z" }),
            summary({ id: 2, number: 12, updated_at: "2023-11-19T00:00:00Z" }),
          ],
          [summary({ id: 3, number: 13, updated_at: "2023-11-18T00:00:00Z" })],
          [summary({ id: 4, number: 14, updated_at: "2023-11-17T00:00:00Z" })],
        ],
      }),
    });

    const pulls = await fetchPullRequests(
      github,
      { owner: "octocat", repo: "hello", since: SINCE, until: UNTIL },
      { perPage: 2 },
    );

    expect(pulls.map((pull) => pull.number)).toEqual([11, 12, 13]);
    expect(
      github.request.mock.calls
        .filter((call) => call[0] === "GET /repos/{owner}/{repo}/pulls" && call[1]?.state === "closed")
        .map((call) => call[1]?.page),
    ).toEqual([1, 2]);
  });

  it("stops at the page cap instead of paging forever", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [
          [
            summary({ number: 1, updated_at: "2023-11-20T00:00:00Z" }),
            summary({ number: 2, updated_at: "2023-11-19T00:00:00Z" }),
          ],
          [
            summary({ number: 3, updated_at: "2023-11-18T00:00:00Z" }),
            summary({ number: 4, updated_at: "2023-11-17T00:00:00Z" }),
          ],
        ],
      }),
    });

    await expect(
      fetchPullRequests(
        github,
        { owner: "octocat", repo: "hello", since: SINCE, until: UNTIL },
        { perPage: 2, maxPages: 2 },
      ),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "GitHub pagination exceeded the page cap",
    });
    expect(
      github.request.mock.calls.filter(
        (call) => call[0] === "GET /repos/{owner}/{repo}/pulls" && call[1]?.state === "closed",
      ),
    ).toHaveLength(2);
  });

  it("enriches overlapping PRs with size and last commit timestamp", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [
          [
            summary({
              id: 41,
              number: 41,
              updated_at: "2023-11-12T00:00:00Z",
              created_at: "2023-10-01T00:00:00Z",
              closed_at: "2023-10-02T00:00:00Z",
              merged_at: "2023-10-02T00:00:00Z",
            }),
            summary({
              id: 42,
              number: 42,
              state: "closed",
              updated_at: "2023-11-20T00:00:00Z",
              created_at: "2023-11-18T08:00:00Z",
              closed_at: "2023-11-20T12:00:00Z",
              merged_at: "2023-11-20T12:00:00Z",
              user: { id: 7, login: "dependabot[bot]", type: "Bot" },
            }),
          ],
        ],
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": (parameters) => {
        expect(parameters).toMatchObject({ owner: "octocat", repo: "hello", pull_number: 42 });
        return {
          id: 42,
          number: 42,
          state: "closed",
          created_at: "2023-11-18T08:00:00Z",
          closed_at: "2023-11-20T12:00:00Z",
          merged_at: "2023-11-20T12:00:00Z",
          additions: 120,
          deletions: 15,
          changed_files: 4,
          user: { id: 7, login: "dependabot[bot]", type: "Bot" },
        };
      },
    });
    github.paginate.mockImplementation(
      async (route: string, parameters: Record<string, unknown>) => {
        expect(route).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits");
        expect(parameters).toMatchObject({ owner: "octocat", repo: "hello", pull_number: 42 });
        return [
          {
            commit: {
              author: { date: "2023-11-18T09:00:00Z" },
              committer: { date: "2023-11-18T09:05:00Z" },
            },
          },
          {
            commit: {
              author: { date: "2023-11-19T10:00:00Z" },
              committer: { date: "2023-11-19T11:30:00Z" },
            },
          },
        ];
      },
    );

    const pulls = await fetchPullRequests(github, {
      owner: "octocat",
      repo: "hello",
      since: SINCE,
      until: UNTIL,
    });

    expect(pulls).toEqual([
      {
        githubId: 42,
        number: 42,
        author: { githubId: 7, login: "dependabot[bot]", isBot: true },
        state: "closed",
        createdAt: Date.parse("2023-11-18T08:00:00Z") / 1000,
        readyAt: null,
        mergedAt: Date.parse("2023-11-20T12:00:00Z") / 1000,
        closedAt: Date.parse("2023-11-20T12:00:00Z") / 1000,
        additions: 120,
        deletions: 15,
        changedFiles: 4,
        lastCommitAt: Date.parse("2023-11-19T11:30:00Z") / 1000,
      },
    ]);
    expect(
      github.request.mock.calls.filter((call) => String(call[0]).includes("{pull_number}")),
    ).toHaveLength(1);
  });

  it("rejects a window whose since is after until", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({}),
    });

    await expect(
      fetchPullRequests(github, {
        owner: "octocat",
        repo: "hello",
        since: UNTIL,
        until: SINCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "since must be less than or equal to until",
    });
    expect(github.request).not.toHaveBeenCalled();
  });

  it("includes boundary PRs and drops PRs that only updated inside the window after closing", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [
          [
            // Updated inside the window but closed before it — must be dropped.
            summary({
              id: 4,
              number: 4,
              updated_at: "2023-11-15T00:00:00Z",
              created_at: "2023-10-01T00:00:00Z",
              closed_at: "2023-10-31T23:59:59Z",
              merged_at: null,
            }),
            // Closed exactly at `since`: the inclusive boundary keeps it.
            summary({
              id: 2,
              number: 2,
              updated_at: "2023-11-01T00:00:00Z",
              created_at: "2023-10-01T00:00:00Z",
              closed_at: "2023-11-01T00:00:00Z",
              merged_at: "2023-11-01T00:00:00Z",
            }),
          ],
        ],
        open: [
          [
            // Created exactly at `until`: the inclusive boundary keeps it.
            open({
              id: 1,
              number: 1,
              created_at: "2023-11-30T23:59:59Z",
              updated_at: "2023-12-15T00:00:00Z",
            }),
            // Created after the window — stops the open scan and is excluded.
            open({
              id: 3,
              number: 3,
              created_at: "2023-12-01T00:00:00Z",
              updated_at: "2023-12-01T00:00:00Z",
            }),
          ],
        ],
      }),
    });

    const pulls = await fetchPullRequests(github, {
      owner: "octocat",
      repo: "hello",
      since: SINCE,
      until: UNTIL,
    });

    expect(pulls.map((pull) => pull.number).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("records a pull request with a deleted author as ghost", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [[summary({ id: 9, number: 9 })]],
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        id: 9,
        number: 9,
        state: "closed",
        created_at: "2023-11-15T00:00:00Z",
        closed_at: "2023-11-16T00:00:00Z",
        merged_at: "2023-11-16T00:00:00Z",
        additions: 10,
        deletions: 1,
        changed_files: 1,
        user: null,
      }),
    });

    const pulls = await fetchPullRequests(github, {
      owner: "octocat",
      repo: "Hello-World",
      since: SINCE,
      until: UNTIL,
    });

    expect(pulls.map((pull) => pull.author)).toEqual([GHOST_ACTOR]);
  });

  it("fails when an overlapping PR has no commit timestamp", async () => {
    const github = client({
      "GET /repos/{owner}/{repo}/pulls": listHandler({
        closed: [[summary({ id: 8, number: 8 })]],
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        id: 8,
        number: 8,
        state: "closed",
        created_at: "2023-11-15T00:00:00Z",
        closed_at: "2023-11-16T00:00:00Z",
        merged_at: "2023-11-16T00:00:00Z",
        additions: 10,
        deletions: 1,
        changed_files: 1,
        user: { id: 1, login: "octocat", type: "User" },
      }),
    });
    github.paginate.mockResolvedValue([{ commit: { author: {}, committer: {} } }]);

    await expect(
      fetchPullRequests(github, {
        owner: "octocat",
        repo: "hello",
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Pull request #8 is missing a last commit timestamp",
    });
  });
});
