import { describe, expect, it } from "vitest";
import type { MetricPullRequest, MetricReview, MetricUser } from "../../src/metrics/loaders.js";
import { buildLeaderboards } from "../../src/metrics/leaderboards.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(
  reviewer: MetricUser,
  githubId: number,
  state: MetricReview["state"] = "COMMENTED",
): MetricReview {
  return {
    id: githubId,
    githubId,
    state,
    submittedAt: 1_100,
    bodyLen: 0,
    commentCount: 0,
    reviewer,
  };
}

function pull(
  author: MetricUser,
  number: number,
  reviews: MetricReview[] = [],
  overrides: Partial<MetricPullRequest> = {},
): MetricPullRequest {
  return {
    id: number,
    githubId: 1000 + number,
    number,
    state: "closed",
    createdAt: 1_000,
    readyAt: 1_000,
    mergedAt: 2_000,
    closedAt: 2_000,
    additions: 10,
    deletions: 1,
    changedFiles: 1,
    lastCommitAt: 1_000,
    author,
    reviews,
    comments: [],
    ...overrides,
  };
}

const ada = user(1, "ada");
const grace = user(2, "grace");
const ken = user(3, "ken");

describe("buildLeaderboards", () => {
  it("orders each board by count, then login, then github id, and ignores input order", () => {
    // Reviewers: ada 3, ken 2, grace 1. Authors: grace 2, then ada before ken.
    // Closers: only merged PRs — ken's abandoned PR does not count.
    const boards = buildLeaderboards({
      pullRequests: [
        pull(ken, 4, [review(ada, 41)], { mergedAt: null, state: "closed" }),
        pull(grace, 2, [review(ken, 21), review(ada, 22, "APPROVED")]),
        pull(ada, 1, [review(ken, 11), review(grace, 12)]),
        pull(grace, 3, [review(ada, 31, "DISMISSED")]),
      ].reverse(),
    });

    expect(boards.reviewers).toEqual([
      { githubId: 1, login: "ada", count: 3 },
      { githubId: 3, login: "ken", count: 2 },
      { githubId: 2, login: "grace", count: 1 },
    ]);
    expect(boards.authors).toEqual([
      { githubId: 2, login: "grace", count: 2 },
      { githubId: 1, login: "ada", count: 1 },
      { githubId: 3, login: "ken", count: 1 },
    ]);
    expect(boards.closers).toEqual([
      { githubId: 2, login: "grace", count: 2 },
      { githubId: 1, login: "ada", count: 1 },
    ]);
  });

  it("drops self-reviews and returns empty boards for an empty window", () => {
    const boards = buildLeaderboards({
      pullRequests: [
        pull(ada, 1, [review(ada, 11, "APPROVED")], { state: "open", mergedAt: null }),
      ],
    });

    expect(boards.reviewers).toEqual([]);
    expect(boards.authors).toEqual([{ githubId: 1, login: "ada", count: 1 }]);
    expect(boards.closers).toEqual([]);
    expect(buildLeaderboards({ pullRequests: [] })).toEqual({
      reviewers: [],
      authors: [],
      closers: [],
    });
  });

  it("breaks a same-login count tie by github id", () => {
    const earlier = user(4, "ada");
    const boards = buildLeaderboards({
      pullRequests: [pull(earlier, 2, []), pull(ada, 1, [review(earlier, 11), review(ada, 12)])],
    });

    expect(boards.authors.map((entry) => entry.githubId)).toEqual([1, 4]);
    expect(boards.reviewers).toEqual([{ githubId: 4, login: "ada", count: 1 }]);
  });
});
