import type { GitHubClient } from "./client.js";
import type {
  FetchPullRequestsOptions,
  FetchPullRequestsQuery,
  GitHubActor,
  PullRequestDto,
} from "./types.js";

const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 100;
const LIST_ROUTE = "GET /repos/{owner}/{repo}/pulls";
const DETAIL_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const COMMITS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";

type RawUser = {
  id?: number;
  login?: string;
  type?: string;
};

type ListedPull = {
  number: number;
  updated_at: string;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
};

type DetailedPull = {
  id: number;
  number: number;
  state: string;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  user: RawUser | null;
};

type RawCommit = {
  commit?: {
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
};

function githubError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function epochSeconds(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw githubError(500, `GitHub returned an invalid ${label}`);
  }
  return Math.floor(parsed / 1000);
}

function optionalEpoch(iso: string | null, label: string): number | null {
  if (!iso) return null;
  return epochSeconds(iso, label);
}

function overlaps(pull: ListedPull, since: number, until: number): boolean {
  const start = epochSeconds(pull.created_at, "created_at");
  const closed = optionalEpoch(pull.closed_at, "closed_at");
  const merged = optionalEpoch(pull.merged_at, "merged_at");
  const end = closed ?? merged ?? Number.POSITIVE_INFINITY;
  return start <= until && end >= since;
}

function actor(user: RawUser | null, pullNumber: number): GitHubActor {
  if (!user || typeof user.id !== "number" || !user.login) {
    throw githubError(500, `Pull request #${pullNumber} is missing an author`);
  }
  const isBot = user.type === "Bot" || user.login.endsWith("[bot]");
  return { githubId: user.id, login: user.login, isBot };
}

function pullState(state: string, pullNumber: number): PullRequestDto["state"] {
  if (state === "open" || state === "closed") return state;
  throw githubError(500, `Pull request #${pullNumber} has an unexpected state`);
}

function requireCount(value: number, label: string, pullNumber: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw githubError(500, `Pull request #${pullNumber} is missing ${label}`);
  }
  return value;
}

function lastCommitAt(commits: RawCommit[], pullNumber: number): number {
  const stamps = commits.flatMap((commit) => {
    const committer = commit.commit?.committer?.date;
    const author = commit.commit?.author?.date;
    const iso = committer || author;
    return iso ? [epochSeconds(iso, "commit date")] : [];
  });
  if (stamps.length === 0) {
    throw githubError(500, `Pull request #${pullNumber} is missing a last commit timestamp`);
  }
  return Math.max(...stamps);
}

async function enrich(
  client: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDto> {
  const detail = await client.request<DetailedPull>(DETAIL_ROUTE, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const commits = await client.paginate<RawCommit>(COMMITS_ROUTE, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  return {
    githubId: detail.id,
    number: detail.number,
    author: actor(detail.user, pullNumber),
    state: pullState(detail.state, pullNumber),
    createdAt: epochSeconds(detail.created_at, "created_at"),
    readyAt: null,
    mergedAt: optionalEpoch(detail.merged_at, "merged_at"),
    closedAt: optionalEpoch(detail.closed_at, "closed_at"),
    additions: requireCount(detail.additions, "additions", pullNumber),
    deletions: requireCount(detail.deletions, "deletions", pullNumber),
    changedFiles: requireCount(detail.changed_files, "changed_files", pullNumber),
    lastCommitAt: lastCommitAt(commits, pullNumber),
  };
}

export async function fetchPullRequests(
  client: GitHubClient,
  query: FetchPullRequestsQuery,
  options: FetchPullRequestsOptions = {},
): Promise<PullRequestDto[]> {
  if (!Number.isFinite(query.since) || !Number.isFinite(query.until) || query.since > query.until) {
    throw githubError(400, "since must be less than or equal to until");
  }

  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const numbers: number[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.request<ListedPull[]>(LIST_ROUTE, {
      owner: query.owner,
      repo: query.repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: perPage,
      page,
    });
    if (batch.length === 0) break;

    let passedWindow = false;
    for (const pull of batch) {
      if (epochSeconds(pull.updated_at, "updated_at") < query.since) {
        passedWindow = true;
        break;
      }
      if (overlaps(pull, query.since, query.until)) {
        numbers.push(pull.number);
      }
    }
    if (passedWindow || batch.length < perPage) break;
    if (page === maxPages) {
      throw githubError(500, "GitHub pagination exceeded the page cap");
    }
  }

  const enriched: PullRequestDto[] = [];
  for (const number of numbers) {
    enriched.push(await enrich(client, query.owner, query.repo, number));
  }
  return enriched;
}
