import { mapWithConcurrency } from "../lib/concurrency.js";
import { httpError } from "../lib/errors.js";
import { toActorOrGhost, type RawGitHubUser } from "./actor.js";
import { DEFAULT_FETCH_CONCURRENCY, type GitHubClient } from "./client.js";
import type {
  FetchReviewsOptions,
  FetchReviewsQuery,
  PullRequestReviewsDto,
  ReviewCommentDto,
  ReviewDto,
  ReviewState,
} from "./types.js";

const REVIEWS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const COMMENTS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments";

const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const;

type RawReview = {
  id?: number;
  state?: string;
  submitted_at?: string | null;
  body?: string | null;
  user?: RawGitHubUser | null;
};

type RawComment = {
  id?: number;
  pull_request_review_id?: number | null;
  created_at?: string | null;
  user?: RawGitHubUser | null;
};

function epochSeconds(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw httpError(500, `GitHub returned an invalid ${label}`);
  }
  return Math.floor(parsed / 1000);
}

function isReviewState(state: string): state is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(state);
}

function reviewDto(raw: RawReview, pullNumber: number, comments: RawComment[]): ReviewDto {
  if (typeof raw.id !== "number") {
    throw httpError(500, `Pull request #${pullNumber} has a review without an id`);
  }
  if (!raw.state || !isReviewState(raw.state)) {
    throw httpError(500, `Review ${raw.id} has an unexpected state`);
  }
  if (!raw.submitted_at) {
    throw httpError(500, `Review ${raw.id} is missing submitted_at`);
  }
  return {
    githubId: raw.id,
    pullNumber,
    reviewer: toActorOrGhost(raw.user),
    state: raw.state,
    submittedAt: epochSeconds(raw.submitted_at, "submitted_at"),
    bodyLen: raw.body?.length ?? 0,
    commentCount: comments.filter((comment) => comment.pull_request_review_id === raw.id).length,
  };
}

function commentDto(raw: RawComment, pullNumber: number): ReviewCommentDto {
  if (typeof raw.id !== "number") {
    throw httpError(500, `Pull request #${pullNumber} has a review comment without an id`);
  }
  if (!raw.created_at) {
    throw httpError(500, `Review comment ${raw.id} is missing created_at`);
  }
  return {
    githubId: raw.id,
    pullNumber,
    reviewGithubId: raw.pull_request_review_id ?? null,
    reviewer: toActorOrGhost(raw.user),
    createdAt: epochSeconds(raw.created_at, "created_at"),
  };
}

async function fetchOne(
  client: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestReviewsDto> {
  const parameters = { owner, repo, pull_number: pullNumber };
  const [rawReviews, rawComments] = await Promise.all([
    client.paginate<RawReview>(REVIEWS_ROUTE, parameters),
    client.paginate<RawComment>(COMMENTS_ROUTE, parameters),
  ]);
  return {
    pullNumber,
    reviews: rawReviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => reviewDto(review, pullNumber, rawComments)),
    reviewComments: rawComments.map((comment) => commentDto(comment, pullNumber)),
  };
}

export async function fetchReviews(
  client: GitHubClient,
  query: FetchReviewsQuery,
  options: FetchReviewsOptions = {},
): Promise<PullRequestReviewsDto[]> {
  const concurrency = options.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  return mapWithConcurrency(query.pullNumbers, concurrency, (pullNumber) =>
    fetchOne(client, query.owner, query.repo, pullNumber),
  );
}
