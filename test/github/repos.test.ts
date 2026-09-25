import { describe, expect, it, vi } from "vitest";
import { listRepos } from "../../src/github/repos.js";
import type { GitHubClient } from "../../src/github/client.js";

const USER_REPOS = "GET /user/repos";
const USERS_REPOS = "GET /users/{username}/repos";
const ORGS_REPOS = "GET /orgs/{org}/repos";

type RawRepo = {
  name?: string;
  full_name?: string;
  private?: boolean;
  visibility?: string;
  default_branch?: string | null;
  pushed_at?: string | null;
  owner?: { login?: string } | null;
};

function raw(overrides: RawRepo = {}): RawRepo {
  return {
    name: "widgets",
    full_name: "acme/widgets",
    private: false,
    visibility: "public",
    default_branch: "main",
    pushed_at: "2024-01-02T00:00:00Z",
    owner: { login: "acme" },
    ...overrides,
  };
}

function client(pages: Record<string, RawRepo[] | Error>): GitHubClient & {
  paginate: ReturnType<typeof vi.fn>;
} {
  const paginate = vi.fn(async (route: string) => {
    const page = pages[route];
    if (!page) throw new Error(`unexpected route ${route}`);
    if (page instanceof Error) throw page;
    return page;
  });
  return { request: vi.fn(), paginate };
}

function notFound(): Error {
  return Object.assign(new Error("GitHub resource not found"), { statusCode: 404 });
}

describe("listRepos", () => {
  it("lists repos the token can access, normalized and sorted by pushedAt desc", async () => {
    const github = client({
      [USER_REPOS]: [
        raw({
          name: "old",
          full_name: "acme/old",
          private: true,
          visibility: "private",
          pushed_at: "2024-01-01T00:00:00Z",
        }),
        raw({
          name: "fresh",
          full_name: "octo/fresh",
          owner: { login: "octo" },
          visibility: "internal",
          pushed_at: "2024-06-01T00:00:00Z",
          default_branch: "develop",
        }),
        raw({ name: "quiet", full_name: "acme/quiet", pushed_at: null }),
        raw({
          name: "same",
          full_name: "acme/same",
          pushed_at: "2024-01-01T00:00:00Z",
        }),
      ],
    });

    const repos = await listRepos(github, {});

    expect(github.paginate).toHaveBeenCalledWith(USER_REPOS, {
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "pushed",
      direction: "desc",
    });
    expect(github.request).not.toHaveBeenCalled();
    expect(repos).toEqual([
      {
        owner: "octo",
        name: "fresh",
        fullName: "octo/fresh",
        visibility: "internal",
        defaultBranch: "develop",
        pushedAt: Date.parse("2024-06-01T00:00:00Z") / 1000,
      },
      {
        owner: "acme",
        name: "old",
        fullName: "acme/old",
        visibility: "private",
        defaultBranch: "main",
        pushedAt: Date.parse("2024-01-01T00:00:00Z") / 1000,
      },
      {
        owner: "acme",
        name: "same",
        fullName: "acme/same",
        visibility: "public",
        defaultBranch: "main",
        pushedAt: Date.parse("2024-01-01T00:00:00Z") / 1000,
      },
      {
        owner: "acme",
        name: "quiet",
        fullName: "acme/quiet",
        visibility: "public",
        defaultBranch: "main",
        pushedAt: null,
      },
    ]);
  });

  it("derives visibility from the private flag when GitHub omits it", async () => {
    const github = client({
      [USER_REPOS]: [raw({ visibility: undefined, private: true, full_name: undefined })],
    });

    await expect(listRepos(github, {})).resolves.toEqual([
      expect.objectContaining({
        fullName: "acme/widgets",
        visibility: "private",
      }),
    ]);
  });

  it("lists a user's public repos and drops private ones the token can see", async () => {
    const github = client({
      [USERS_REPOS]: [
        raw({ name: "secret", full_name: "someuser/secret", private: true, visibility: "private" }),
        raw({
          name: "open",
          full_name: "someuser/open",
          owner: { login: "someuser" },
          pushed_at: "2024-03-01T00:00:00Z",
        }),
      ],
    });

    const repos = await listRepos(github, { owner: "someuser" });

    expect(github.paginate).toHaveBeenCalledWith(USERS_REPOS, {
      username: "someuser",
      type: "owner",
      sort: "pushed",
      direction: "desc",
    });
    expect(github.paginate).not.toHaveBeenCalledWith(ORGS_REPOS, expect.anything());
    expect(repos.map((repo) => repo.fullName)).toEqual(["someuser/open"]);
  });

  it("falls back to an org's public repos when the owner is not a user", async () => {
    const github = client({
      [USERS_REPOS]: notFound(),
      [ORGS_REPOS]: [
        raw({
          name: "platform",
          full_name: "acme/platform",
          pushed_at: "2024-04-01T00:00:00Z",
        }),
        raw({
          name: "hidden",
          full_name: "acme/hidden",
          private: true,
          visibility: "private",
        }),
      ],
    });

    const repos = await listRepos(github, { owner: "acme" });

    expect(github.paginate).toHaveBeenCalledWith(ORGS_REPOS, {
      org: "acme",
      type: "public",
      sort: "pushed",
      direction: "desc",
    });
    expect(repos.map((repo) => repo.name)).toEqual(["platform"]);
  });

  it("maps a missing user and org to a 404 that does not echo the token", async () => {
    const github = client({
      [USERS_REPOS]: notFound(),
      [ORGS_REPOS]: Object.assign(new Error("Not Found ghp_secret"), { statusCode: 404 }),
    });

    await expect(listRepos(github, { owner: "missing" })).rejects.toMatchObject({
      statusCode: 404,
      message: "Owner missing not found",
    });
  });

  it("does not swallow a bad token as a missing owner", async () => {
    const github = client({
      [USER_REPOS]: Object.assign(new Error("Bad credentials"), { statusCode: 401 }),
    });

    await expect(listRepos(github, {})).rejects.toMatchObject({ statusCode: 401 });
    expect(github.paginate).toHaveBeenCalledOnce();
  });

  it("rejects a repository payload that is missing an owner", async () => {
    const github = client({
      [USER_REPOS]: [raw({ owner: null, full_name: undefined })],
    });

    await expect(listRepos(github, {})).rejects.toMatchObject({
      statusCode: 500,
      message: "GitHub repository is missing an owner",
    });
  });
});
