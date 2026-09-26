import { describe, expect, it } from "vitest";
import type {
  MetricComment,
  MetricPullRequest,
  MetricReview,
  MetricUser,
} from "../../src/metrics/loaders.js";
import { computeLoadBalance, DEFAULT_BUS_FACTOR_COVERAGE } from "../../src/metrics/loadbalance.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(reviewer: MetricUser, githubId: number): MetricReview {
  return {
    id: githubId,
    githubId,
    state: "COMMENTED",
    submittedAt: 1_100,
    bodyLen: 0,
    commentCount: 0,
    reviewer,
  };
}

function comment(reviewer: MetricUser, githubId: number): MetricComment {
  return { id: githubId, githubId, createdAt: 1_200, reviewer };
}

function pull(
  author: MetricUser,
  number: number,
  reviews: MetricReview[] = [],
  comments: MetricComment[] = [],
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
    comments,
  };
}

const ada = user(1, "ada");
const grace = user(2, "grace");
const ken = user(3, "ken");
const linus = user(4, "linus");

describe("computeLoadBalance", () => {
  it("scores a uniform review load at 0 and a one-person load at (n - 1) / n", () => {
    const uniform = computeLoadBalance({
      pullRequests: [
        pull(ada, 1, [review(grace, 11), review(ken, 12)]),
        pull(grace, 2, [review(ada, 21), review(linus, 22)]),
        pull(ken, 3, [review(ada, 31), review(linus, 32)]),
        pull(linus, 4, [review(grace, 41), review(ken, 42)]),
      ],
    });
    const skewed = computeLoadBalance({
      pullRequests: [
        pull(grace, 1, [review(ada, 11)], [comment(ken, 101), comment(linus, 102)]),
        pull(grace, 2, [review(ada, 21)]),
        pull(grace, 3, [review(ada, 31)]),
        pull(grace, 4, [review(ada, 41)]),
        pull(grace, 5, [review(ada, 51)]),
        pull(grace, 6, [review(ada, 61)]),
      ],
    });

    expect(uniform.reviews.concentration).toEqual({ gini: 0, population: 4, total: 8 });
    expect(uniform.reviews.distribution.map((entry) => entry.share)).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
    expect(skewed.reviews.concentration.gini).toBe(0.75);
    expect(skewed.reviews.concentration).toMatchObject({ population: 4, total: 6 });
    expect(skewed.reviews.distribution[0]).toMatchObject({ login: "ada", count: 6, share: 1 });
  });

  it("matches the hand-worked Gini for review counts 1, 2, and 3", () => {
    // ada 1, grace 2, ken 3. Authors are the same three people, so nobody idle dilutes the sample.
    const report = computeLoadBalance({
      pullRequests: [
        pull(ken, 1, [review(ada, 11)]),
        pull(ken, 2, [review(grace, 21)]),
        pull(ken, 3, [review(grace, 31)]),
        pull(ada, 4, [review(ken, 41)]),
        pull(ada, 5, [review(ken, 51)]),
        pull(grace, 6, [review(ken, 61)]),
      ],
    });

    expect(report.reviews.distribution.map((entry) => [entry.login, entry.count])).toEqual([
      ["ken", 3],
      ["grace", 2],
      ["ada", 1],
    ]);
    expect(report.reviews.concentration.gini).toBeCloseTo(2 / 9, 10);
  });

  it("takes the smallest prefix that covers half, tie-breaking by login", () => {
    const reviews = computeLoadBalance({
      pullRequests: [
        ...Array.from({ length: 5 }, (_, index) =>
          pull(grace, index + 1, [review(ada, 10 + index)]),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          pull(linus, index + 6, [review(grace, 20 + index)]),
        ),
        pull(ken, 9, [review(linus, 31)]),
      ],
    });
    const authorship = computeLoadBalance({
      pullRequests: [pull(ada, 1), pull(grace, 2), pull(linus, 3)],
    });

    expect(reviews.coverage).toBe(DEFAULT_BUS_FACTOR_COVERAGE);
    expect(reviews.reviews.busFactor.count).toBe(1);
    expect(reviews.reviews.busFactor.contributors.map((entry) => entry.login)).toEqual(["ada"]);
    expect(reviews.authorship.busFactor.count).toBe(1);
    expect(reviews.authorship.busFactor.contributors.map((entry) => entry.login)).toEqual([
      "grace",
    ]);
    expect(authorship.authorship.busFactor).toMatchObject({ count: 2, total: 3, coverage: 0.5 });
    expect(authorship.authorship.busFactor.contributors.map((entry) => entry.login)).toEqual([
      "ada",
      "grace",
    ]);
    expect(authorship.reviews.busFactor.count).toBeNull();
  });

  it("excludes self-reviews and leaves an empty window undefined rather than zero", () => {
    const selfOnly = computeLoadBalance({
      pullRequests: [pull(ada, 1, [review(ada, 11)])],
    });

    expect(selfOnly.reviews.concentration.gini).toBeNull();
    expect(selfOnly.reviews.distribution).toEqual([
      { githubId: 1, login: "ada", count: 0, share: 0 },
    ]);
    expect(selfOnly.authorship.concentration.gini).toBe(0);
    expect(selfOnly.authorship.busFactor.count).toBe(1);
    expect(computeLoadBalance({ pullRequests: [] })).toMatchObject({
      reviews: {
        distribution: [],
        concentration: { gini: null, population: 0, total: 0 },
        busFactor: { count: null, contributors: [] },
      },
      authorship: {
        distribution: [],
        concentration: { gini: null, population: 0, total: 0 },
        busFactor: { count: null },
      },
    });
  });

  it("rejects a coverage outside (0, 1]", () => {
    expect(() => computeLoadBalance({ pullRequests: [] }, { coverage: 0 })).toThrow(
      /coverage must be greater than 0 and at most 1/,
    );
    expect(() => computeLoadBalance({ pullRequests: [] }, { coverage: 1.1 })).toThrow(
      /coverage must be greater than 0 and at most 1/,
    );
  });
});
