import { describe, expect, it } from "vitest";
import type {
  MetricComment,
  MetricPullRequest,
  MetricReview,
  MetricUser,
} from "../../src/metrics/loaders.js";
import {
  DEFAULT_FAST_APPROVAL_SECONDS,
  DEFAULT_MIN_PR_SIZE,
  detectRubberStamps,
} from "../../src/metrics/rubberstamp.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(
  reviewer: MetricUser,
  githubId: number,
  submittedAt: number,
  overrides: Partial<MetricReview> = {},
): MetricReview {
  return {
    id: githubId,
    githubId,
    state: "APPROVED",
    submittedAt,
    bodyLen: 0,
    commentCount: 0,
    reviewer,
    ...overrides,
  };
}

function comment(reviewer: MetricUser, githubId: number, createdAt = 1): MetricComment {
  return { id: githubId, githubId, createdAt, reviewer };
}

function pull(
  author: MetricUser,
  number: number,
  reviews: MetricReview[],
  overrides: Partial<MetricPullRequest> = {},
): MetricPullRequest {
  return {
    id: number,
    githubId: 1000 + number,
    number,
    state: "open",
    createdAt: 1_000,
    readyAt: null,
    mergedAt: null,
    closedAt: null,
    additions: 80,
    deletions: 21,
    changedFiles: 4,
    lastCommitAt: 1_000,
    author,
    reviews,
    comments: [],
    ...overrides,
  };
}

const ada = user(1, "ada");
const grace = user(2, "grace");
const linus = user(3, "linus");

const thresholds = { fastApprovalSeconds: 300, minPrSize: 100 };

describe("detectRubberStamps", () => {
  it("flags an approval only when it is fast, silent, and on a PR larger than the size threshold", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 1_299)]),
          pull(grace, 2, [review(ada, 11, 1_300)]),
          pull(grace, 3, [review(ada, 12, 1_050, { commentCount: 1 })]),
          pull(grace, 4, [review(ada, 13, 1_050)], { additions: 60, deletions: 40 }),
        ],
      },
      thresholds,
    );

    expect(report.approvals.map((approval) => [approval.reviewGithubId, approval.flagged])).toEqual(
      [
        [10, true],
        [11, false],
        [12, false],
        [13, false],
      ],
    );
    expect(report.reviewers).toEqual([
      expect.objectContaining({
        reviewer: ada,
        flagged: 1,
        eligible: 4,
        rate: 0.25,
      }),
    ]);
  });

  it("never flags a PR at or under the size threshold, even when the approval is instant and silent", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 1_000)], { additions: 100, deletions: 0 }),
          pull(grace, 2, [review(ada, 11, 1_000)], { additions: 1, deletions: 2 }),
        ],
      },
      thresholds,
    );

    expect(report.approvals.every((approval) => approval.flagged === false)).toBe(true);
    expect(report.reviewers[0]).toMatchObject({ flagged: 0, eligible: 2, rate: 0 });
  });

  it("treats one line over the size threshold as large enough to flag", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [pull(grace, 1, [review(ada, 10, 1_001)], { additions: 100, deletions: 1 })],
      },
      thresholds,
    );

    expect(report.approvals[0]).toMatchObject({
      timeToApproval: 1,
      prSize: 101,
      commentCount: 0,
      flagged: true,
    });
  });

  it("counts a review comment anywhere on the PR as scrutiny, not only comments linked to the approval", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 1_010)], {
            comments: [comment(ada, 50, 900), comment(linus, 51, 950)],
          }),
        ],
      },
      thresholds,
    );

    expect(report.approvals[0]).toMatchObject({ commentCount: 1, flagged: false });
  });

  it("measures time from the last commit at or before the review, then ready, then created", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 2_000)], { lastCommitAt: 1_800, readyAt: 1_200 }),
          pull(grace, 2, [review(ada, 11, 1_500)], { lastCommitAt: 1_900, readyAt: 1_400 }),
          pull(grace, 3, [review(ada, 12, 1_200)], {
            lastCommitAt: null,
            readyAt: null,
            createdAt: 1_000,
          }),
        ],
      },
      thresholds,
    );

    expect(report.approvals.map((approval) => approval.timeToApproval)).toEqual([200, 100, 200]);
    expect(report.approvals.every((approval) => approval.flagged)).toBe(true);
  });

  it("drops an approval submitted before every available baseline from the denominator", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 500)], {
            createdAt: 1_000,
            readyAt: 1_100,
            lastCommitAt: 1_200,
          }),
          pull(grace, 2, [review(ada, 11, 1_050)]),
        ],
      },
      thresholds,
    );

    expect(report.approvals.map((approval) => approval.reviewGithubId)).toEqual([11]);
    expect(report.reviewers[0]).toMatchObject({ flagged: 1, eligible: 1, rate: 1 });
  });

  it("excludes non-approvals from eligible and flagged counts", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [
            review(ada, 10, 1_010, { state: "COMMENTED" }),
            review(ada, 11, 1_020, { state: "CHANGES_REQUESTED" }),
            review(ada, 12, 1_030, { state: "DISMISSED" }),
            review(ada, 13, 1_040),
          ]),
        ],
      },
      thresholds,
    );

    expect(report.approvals).toHaveLength(1);
    expect(report.reviewers[0]).toMatchObject({ flagged: 1, eligible: 1, rate: 1 });
  });

  it("rates each reviewer as flagged divided by their eligible approvals, and splits the same ratio per author", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10, 1_010)]),
          pull(grace, 2, [review(ada, 11, 5_000)]),
          pull(linus, 3, [review(ada, 12, 1_010)]),
          pull(ada, 4, [review(grace, 13, 1_010)]),
        ],
      },
      thresholds,
    );

    expect(report.reviewers).toEqual([
      expect.objectContaining({ reviewer: ada, flagged: 2, eligible: 3, rate: 2 / 3 }),
      expect.objectContaining({ reviewer: grace, flagged: 1, eligible: 1, rate: 1 }),
    ]);
    expect(report.pairs).toEqual([
      expect.objectContaining({
        reviewer: ada,
        author: grace,
        flagged: 1,
        eligible: 2,
        rate: 0.5,
      }),
      expect.objectContaining({ reviewer: ada, author: linus, flagged: 1, eligible: 1, rate: 1 }),
      expect.objectContaining({ reviewer: grace, author: ada, flagged: 1, eligible: 1, rate: 1 }),
    ]);
  });

  it("includes a self-approval in the reviewer's rate and as its own pair", () => {
    const report = detectRubberStamps(
      { pullRequests: [pull(ada, 1, [review(ada, 10, 1_010), review(grace, 11, 1_010)])] },
      thresholds,
    );

    expect(report.pairs).toEqual([
      expect.objectContaining({ reviewer: ada, author: ada, flagged: 1, eligible: 1 }),
      expect.objectContaining({ reviewer: grace, author: ada, flagged: 1, eligible: 1 }),
    ]);
  });

  it("uses the configured defaults and returns a null rate when nobody approved", () => {
    const report = detectRubberStamps({
      pullRequests: [pull(grace, 1, [review(ada, 10, 1_010, { state: "COMMENTED" })])],
    });

    expect(report.fastApprovalSeconds).toBe(DEFAULT_FAST_APPROVAL_SECONDS);
    expect(report.minPrSize).toBe(DEFAULT_MIN_PR_SIZE);
    expect(DEFAULT_FAST_APPROVAL_SECONDS).toBe(300);
    expect(DEFAULT_MIN_PR_SIZE).toBe(100);
    expect(report.approvals).toEqual([]);
    expect(report.reviewers).toEqual([]);
    expect(report.pairs).toEqual([]);
  });

  it("orders approvals, reviewers, and pairs deterministically", () => {
    const report = detectRubberStamps(
      {
        pullRequests: [
          pull(linus, 3, [review(grace, 30, 1_100), review(ada, 31, 1_050)]),
          pull(grace, 1, [review(ada, 12, 1_200), review(ada, 11, 1_100)]),
        ],
      },
      thresholds,
    );

    expect(report.approvals.map((approval) => approval.reviewGithubId)).toEqual([11, 12, 31, 30]);
    expect(report.reviewers.map((row) => row.reviewer.login)).toEqual(["ada", "grace"]);
    expect(report.pairs.map((pair) => `${pair.reviewer.login}->${pair.author.login}`)).toEqual([
      "ada->grace",
      "ada->linus",
      "grace->linus",
    ]);
  });
});
