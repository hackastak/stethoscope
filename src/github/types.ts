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

/** Submitted review states. PENDING reviews are omitted by the fetcher. */
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export type ReviewDto = {
  githubId: number;
  pullNumber: number;
  reviewer: GitHubActor;
  state: ReviewState;
  submittedAt: number;
  bodyLen: number;
  /** Inline review comments whose pull_request_review_id matches this review. */
  commentCount: number;
};

export type ReviewCommentDto = {
  githubId: number;
  pullNumber: number;
  /** Null when GitHub did not attach the comment to a submitted review. */
  reviewGithubId: number | null;
  reviewer: GitHubActor;
  createdAt: number;
};

export type PullRequestReviewsDto = {
  pullNumber: number;
  reviews: ReviewDto[];
  reviewComments: ReviewCommentDto[];
};

export type FetchReviewsQuery = {
  owner: string;
  repo: string;
  pullNumbers: readonly number[];
};
