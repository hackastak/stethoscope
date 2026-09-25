export type GitHubActor = {
  githubId: number;
  login: string;
  isBot: boolean;
};

export type PullRequestDto = {
  githubId: number;
  number: number;
  author: GitHubActor;
  state: "open" | "closed";
  createdAt: number;
  readyAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  lastCommitAt: number;
};

export type FetchPullRequestsQuery = {
  owner: string;
  repo: string;
  /** Inclusive window start, unix epoch seconds. */
  since: number;
  /** Inclusive window end, unix epoch seconds. */
  until: number;
};

export type FetchPullRequestsOptions = {
  perPage?: number;
  maxPages?: number;
};
