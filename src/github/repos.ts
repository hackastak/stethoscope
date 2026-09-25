import type { GitHubClient } from "./client.js";

const USER_REPOS = "GET /user/repos";
const USERS_REPOS = "GET /users/{username}/repos";
const ORGS_REPOS = "GET /orgs/{org}/repos";

const AUTHED_PARAMS = {
  visibility: "all",
  affiliation: "owner,collaborator,organization_member",
  sort: "pushed",
  direction: "desc",
} as const;

export type RepoVisibility = "public" | "private" | "internal";

export type RepoSummary = {
  owner: string;
  name: string;
  fullName: string;
  visibility: RepoVisibility;
  defaultBranch: string;
  /** Unix epoch seconds. Null when GitHub has no push timestamp. */
  pushedAt: number | null;
};

export type ListReposQuery = {
  owner?: string;
};

type RawRepo = {
  name?: string;
  full_name?: string;
  private?: boolean;
  visibility?: string;
  default_branch?: string | null;
  pushed_at?: string | null;
  owner?: { login?: string } | null;
};

function githubError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function statusCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}

function pushedAt(iso: string | null | undefined, fullName: string): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw githubError(500, `GitHub repository ${fullName} has an invalid pushed_at`);
  }
  return Math.floor(parsed / 1000);
}

function visibility(raw: RawRepo, fullName: string): RepoVisibility {
  if (
    raw.visibility === "public" ||
    raw.visibility === "private" ||
    raw.visibility === "internal"
  ) {
    return raw.visibility;
  }
  if (typeof raw.private === "boolean") return raw.private ? "private" : "public";
  throw githubError(500, `GitHub repository ${fullName} is missing visibility`);
}

function normalize(raw: RawRepo): RepoSummary {
  const owner = raw.owner?.login;
  const name = raw.name;
  if (!owner) throw githubError(500, "GitHub repository is missing an owner");
  if (!name) throw githubError(500, "GitHub repository is missing a name");
  if (!raw.default_branch) {
    throw githubError(500, `GitHub repository ${owner}/${name} is missing a default branch`);
  }
  const fullName = raw.full_name && raw.full_name.length > 0 ? raw.full_name : `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    visibility: visibility(raw, fullName),
    defaultBranch: raw.default_branch,
    pushedAt: pushedAt(raw.pushed_at, fullName),
  };
}

function compareName(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function byRecentPush(left: RepoSummary, right: RepoSummary): number {
  if (left.pushedAt === null && right.pushedAt === null) {
    return compareName(left.fullName, right.fullName);
  }
  if (left.pushedAt === null) return 1;
  if (right.pushedAt === null) return -1;
  if (left.pushedAt !== right.pushedAt) return right.pushedAt - left.pushedAt;
  return compareName(left.fullName, right.fullName);
}

function publicOnly(repos: RepoSummary[]): RepoSummary[] {
  return repos.filter((repo) => repo.visibility === "public");
}

async function paginateRepos(
  client: GitHubClient,
  route: string,
  parameters: Record<string, unknown>,
): Promise<RepoSummary[]> {
  const page = await client.paginate<RawRepo>(route, parameters);
  return page.map(normalize).sort(byRecentPush);
}

async function listOwnerRepos(client: GitHubClient, owner: string): Promise<RepoSummary[]> {
  try {
    const repos = await paginateRepos(client, USERS_REPOS, {
      username: owner,
      type: "owner",
      sort: "pushed",
      direction: "desc",
    });
    return publicOnly(repos);
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }

  try {
    const repos = await paginateRepos(client, ORGS_REPOS, {
      org: owner,
      type: "public",
      sort: "pushed",
      direction: "desc",
    });
    return publicOnly(repos);
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
    throw githubError(404, `Owner ${owner} not found`);
  }
}

/** Repos the configured token can read, or one owner/org's public repos. */
export async function listRepos(
  client: GitHubClient,
  query: ListReposQuery = {},
): Promise<RepoSummary[]> {
  if (query.owner) return listOwnerRepos(client, query.owner);
  return paginateRepos(client, USER_REPOS, { ...AUTHED_PARAMS });
}
