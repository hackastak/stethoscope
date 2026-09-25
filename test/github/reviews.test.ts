import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../src/github/index.js";
import { fetchReviews } from "../../src/github/index.js";

const REVIEWS = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const COMMENTS = "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments";

function client(pages: Record<string, Record<number, unknown[]>>): GitHubClient & {
  paginate: ReturnType<typeof vi.fn>;
} {
  return {
    request: vi.fn(),
    paginate: vi.fn(async (route: string, parameters: Record<string, unknown> = {}) => {
      const pullNumber = Number(parameters.pull_number);
      return pages[route]?.[pullNumber] ?? [];
    }),
  };
}

describe("fetchReviews", () => {
  it("returns reviews with state, submitted_at, reviewer, and body length", async () => {
    const github = client({
      [REVIEWS]: {
        7: [
          {
            id: 100,
            state: "APPROVED",
            submitted_at: "2023-11-18T12:00:00Z",
            body: "LGTM",
            user: { id: 2, login: "reviewer", type: "User" },
          },
          {
            id: 101,
            state: "CHANGES_REQUESTED",
            submitted_at: "2023-11-18T13:00:00Z",
            body: null,
            user: { id: 3, login: "ada", type: "User" },
          },
        ],
      },
      [COMMENTS]: { 7: [] },
    });

    const activity = await fetchReviews(github, {
      owner: "octocat",
      repo: "hello",
      pullNumbers: [7],
    });

    expect(activity).toEqual([
      {
        pullNumber: 7,
        reviews: [
          {
            githubId: 100,
            pullNumber: 7,
            reviewer: { githubId: 2, login: "reviewer", isBot: false },
            state: "APPROVED",
            submittedAt: Date.parse("2023-11-18T12:00:00Z") / 1000,
            bodyLen: 4,
            commentCount: 0,
          },
          {
            githubId: 101,
            pullNumber: 7,
            reviewer: { githubId: 3, login: "ada", isBot: false },
            state: "CHANGES_REQUESTED",
            submittedAt: Date.parse("2023-11-18T13:00:00Z") / 1000,
            bodyLen: 0,
            commentCount: 0,
          },
        ],
        reviewComments: [],
      },
    ]);
    expect(github.paginate).toHaveBeenCalledWith(REVIEWS, {
      owner: "octocat",
      repo: "hello",
      pull_number: 7,
    });
    expect(github.paginate).toHaveBeenCalledWith(COMMENTS, {
      owner: "octocat",
      repo: "hello",
      pull_number: 7,
    });
    expect(github.request).not.toHaveBeenCalled();
  });

  it("attributes review comments to the review and reviewer on that PR only", async () => {
    const github = client({
      [REVIEWS]: {
        1: [
          {
            id: 10,
            state: "COMMENTED",
            submitted_at: "2023-11-02T00:00:00Z",
            body: "see inline",
            user: { id: 2, login: "ada", type: "User" },
          },
          {
            id: 11,
            state: "APPROVED",
            submitted_at: "2023-11-03T00:00:00Z",
            body: "",
            user: { id: 4, login: "grace", type: "User" },
          },
        ],
        2: [
          {
            id: 20,
            state: "DISMISSED",
            submitted_at: "2023-11-04T00:00:00Z",
            body: "superseded",
            user: { id: 2, login: "ada", type: "User" },
          },
        ],
      },
      [COMMENTS]: {
        1: [
          {
            id: 501,
            pull_request_review_id: 10,
            created_at: "2023-11-02T00:01:00Z",
            user: { id: 2, login: "ada", type: "User" },
          },
          {
            id: 502,
            pull_request_review_id: 10,
            created_at: "2023-11-02T00:02:00Z",
            user: { id: 9, login: "reply-guy", type: "User" },
          },
          {
            id: 503,
            pull_request_review_id: null,
            created_at: "2023-11-02T00:03:00Z",
            user: { id: 4, login: "grace", type: "User" },
          },
        ],
        2: [
          {
            id: 601,
            pull_request_review_id: 10,
            created_at: "2023-11-04T00:01:00Z",
            user: { id: 2, login: "ada", type: "User" },
          },
        ],
      },
    });

    const activity = await fetchReviews(github, {
      owner: "octocat",
      repo: "hello",
      pullNumbers: [1, 2],
    });

    expect(activity[0]?.reviews.map((review) => review.commentCount)).toEqual([2, 0]);
    expect(activity[0]?.reviewComments).toEqual([
      {
        githubId: 501,
        pullNumber: 1,
        reviewGithubId: 10,
        reviewer: { githubId: 2, login: "ada", isBot: false },
        createdAt: Date.parse("2023-11-02T00:01:00Z") / 1000,
      },
      {
        githubId: 502,
        pullNumber: 1,
        reviewGithubId: 10,
        reviewer: { githubId: 9, login: "reply-guy", isBot: false },
        createdAt: Date.parse("2023-11-02T00:02:00Z") / 1000,
      },
      {
        githubId: 503,
        pullNumber: 1,
        reviewGithubId: null,
        reviewer: { githubId: 4, login: "grace", isBot: false },
        createdAt: Date.parse("2023-11-02T00:03:00Z") / 1000,
      },
    ]);
    expect(activity[1]?.reviews[0]?.commentCount).toBe(0);
    expect(activity[1]?.reviewComments.map((comment) => comment.githubId)).toEqual([601]);
    expect(activity[1]?.reviewComments[0]?.pullNumber).toBe(2);
  });

  it("flags bot reviewers and commenters", async () => {
    const github = client({
      [REVIEWS]: {
        3: [
          {
            id: 30,
            state: "APPROVED",
            submitted_at: "2023-11-05T00:00:00Z",
            body: "ok",
            user: { id: 8, login: "dependabot[bot]", type: "Bot" },
          },
          {
            id: 31,
            state: "COMMENTED",
            submitted_at: "2023-11-05T01:00:00Z",
            body: "nit",
            user: { id: 12, login: "coderabbit[bot]", type: "User" },
          },
        ],
      },
      [COMMENTS]: {
        3: [
          {
            id: 70,
            pull_request_review_id: 31,
            created_at: "2023-11-05T01:01:00Z",
            user: { id: 12, login: "coderabbit[bot]", type: "User" },
          },
        ],
      },
    });

    const [activity] = await fetchReviews(github, {
      owner: "octocat",
      repo: "hello",
      pullNumbers: [3],
    });

    expect(activity?.reviews.map((review) => review.reviewer.isBot)).toEqual([true, true]);
    expect(activity?.reviewComments[0]?.reviewer.isBot).toBe(true);
    expect(activity?.reviews[1]?.commentCount).toBe(1);
  });

  it("skips pending reviews and keeps an empty result for a PR with no activity", async () => {
    const github = client({
      [REVIEWS]: {
        4: [
          {
            id: 40,
            state: "PENDING",
            submitted_at: null,
            body: "draft",
            user: { id: 2, login: "ada", type: "User" },
          },
        ],
      },
      [COMMENTS]: { 4: [], 5: [] },
    });

    const activity = await fetchReviews(github, {
      owner: "octocat",
      repo: "hello",
      pullNumbers: [4, 5],
    });

    expect(activity).toEqual([
      { pullNumber: 4, reviews: [], reviewComments: [] },
      { pullNumber: 5, reviews: [], reviewComments: [] },
    ]);
  });

  it("does not call GitHub when there are no pull requests", async () => {
    const github = client({});

    await expect(
      fetchReviews(github, { owner: "octocat", repo: "hello", pullNumbers: [] }),
    ).resolves.toEqual([]);
    expect(github.paginate).not.toHaveBeenCalled();
  });

  it("rejects a submitted review with no timestamp or an unexpected state", async () => {
    const missingTime = client({
      [REVIEWS]: {
        8: [
          {
            id: 80,
            state: "APPROVED",
            submitted_at: null,
            body: "",
            user: { id: 2, login: "ada", type: "User" },
          },
        ],
      },
      [COMMENTS]: { 8: [] },
    });

    await expect(
      fetchReviews(missingTime, { owner: "octocat", repo: "hello", pullNumbers: [8] }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Review 80 is missing submitted_at",
    });

    const unexpected = client({
      [REVIEWS]: {
        9: [
          {
            id: 90,
            state: "REQUESTED",
            submitted_at: "2023-11-06T00:00:00Z",
            body: "",
            user: { id: 2, login: "ada", type: "User" },
          },
        ],
      },
      [COMMENTS]: { 9: [] },
    });

    await expect(
      fetchReviews(unexpected, { owner: "octocat", repo: "hello", pullNumbers: [9] }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Review 90 has an unexpected state",
    });
  });
});
