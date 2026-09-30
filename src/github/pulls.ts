import { httpError } from "../lib/errors.js";
import { toActorOrGhost, type RawGitHubUser } from "./actor.js";
import type { GitHubClient } from "./client.js";
import type { FetchPullRequestsOptions, FetchPullRequestsQuery, PullRequestDto } from "./types.js";

const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 100;
const LIST_ROUTE = "GET /repos/{owner}/{repo}/pulls";
const DETAIL_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const COMMITS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";

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
  user: RawGitHubUser | null;
};

type RawCommit = {
  commit?: {
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
};

function epochSeconds(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw httpError(500, `GitHub returned an invalid ${label}`);
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

function pullState(state: string, pullNumber: number): PullRequestDto["state"] {
  if (state === "open" || state === "closed") return state;
  throw httpError(500, `Pull request #${pullNumber} has an unexpected state`);
}

function requireCount(value: number, label: string, pullNumber: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(500, `Pull request #${pullNumber} is missing ${label}`);
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
    throw httpError(500, `Pull request #${pullNumber} is missing a last commit timestamp`);
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
    author: toActorOrGhost(detail.user),
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

type ListSort = {
  state: "open" | "closed";
  sort: "updated" | "created";
  direction: "asc" | "desc";
};

/**
 * Page one `state`-filtered listing in the given sort order, collecting the
 * numbers of every PR whose lifetime overlaps the window. `reachedEnd` is the
 * early-termination predicate: because the listing is sorted, the first PR that
 * satisfies it guarantees no later PR can overlap, so paging stops.
 */
async function collectWindowNumbers(
  client: GitHubClient,
  query: FetchPullRequestsQuery,
  perPage: number,
  maxPages: number,
  list: ListSort,
  reachedEnd: (pull: ListedPull) => boolean,
  sink: Set<number>,
): Promise<void> {
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.request<ListedPull[]>(LIST_ROUTE, {
      owner: query.owner,
      repo: query.repo,
      state: list.state,
      sort: list.sort,
      direction: list.direction,
      per_page: perPage,
      page,
    });
    if (batch.length === 0) break;

    let done = false;
    for (const pull of batch) {
      if (reachedEnd(pull)) {
        done = true;
        break;
      }
      if (overlaps(pull, query.since, query.until)) {
        sink.add(pull.number);
      }
    }
    if (done || batch.length < perPage) break;
    if (page === maxPages) {
      throw httpError(500, "GitHub pagination exceeded the page cap");
    }
  }
}

export async function fetchPullRequests(
  client: GitHubClient,
  query: FetchPullRequestsQuery,
  options: FetchPullRequestsOptions = {},
): Promise<PullRequestDto[]> {
  if (!Number.isFinite(query.since) || !Number.isFinite(query.until) || query.since > query.until) {
    throw httpError(400, "since must be less than or equal to until");
  }

  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const numbers = new Set<number>();

  // Closed/merged PRs have a bounded lifetime end (closed_at/merged_at, always
  // <= updated_at), so scanning newest-updated first lets us stop as soon as a
  // PR's last update falls before the window: everything older is out too.
  await collectWindowNumbers(
    client,
    query,
    perPage,
    maxPages,
    { state: "closed", sort: "updated", direction: "desc" },
    (pull) => epochSeconds(pull.updated_at, "updated_at") < query.since,
    numbers,
  );

  // Open PRs run to +infinity, so updated_at says nothing about overlap — a
  // dormant PR opened before `since` and untouched since still overlaps. Scan
  // by creation ascending and stop only once a PR was created after the window.
  await collectWindowNumbers(
    client,
    query,
    perPage,
    maxPages,
    { state: "open", sort: "created", direction: "asc" },
    (pull) => epochSeconds(pull.created_at, "created_at") > query.until,
    numbers,
  );

  const enriched: PullRequestDto[] = [];
  for (const number of numbers) {
    enriched.push(await enrich(client, query.owner, query.repo, number));
  }
  return enriched;
}
