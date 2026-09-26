import { describe, expect, it } from "vitest";
import type { MetricPullRequest, MetricReview, MetricUser } from "../../src/metrics/loaders.js";
import { computeCycleTime } from "../../src/metrics/cycletime.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(
  reviewer: MetricUser,
  githubId: number,
  submittedAt: number,
  state: MetricReview["state"] = "COMMENTED",
): MetricReview {
  return {
    id: githubId,
    githubId,
    state,
    submittedAt,
    bodyLen: 0,
    commentCount: 0,
    reviewer,
  };
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

describe("computeCycleTime", () => {
  it("reports type-7 median and p75 from a hand-worked sample, and drops missing stages instead of zero-filling them", () => {
    // PR 1: 10, 20, 40
    // PR 2: 20, missing approval, missing merge interval
    // PR 3: review before ready (dropped), then 10 and 40
    // PR 4: open, not merged — omitted entirely
    // PR 5: 40, 0 (approved on first review), 40
    const report = computeCycleTime({
      pullRequests: [
        pull(grace, 5, [review(ada, 50, 1_040, "APPROVED")], { mergedAt: 1_080 }),
        pull(grace, 4, [review(ada, 40, 1_010, "APPROVED")], { mergedAt: null, state: "open" }),
        pull(grace, 1, [review(ada, 11, 1_010), review(ada, 12, 1_030, "APPROVED")], {
          mergedAt: 1_070,
        }),
        pull(grace, 2, [review(ada, 20, 1_020)], { mergedAt: 1_100 }),
        pull(grace, 3, [review(ada, 30, 900, "COMMENTED"), review(ada, 31, 910, "APPROVED")], {
          readyAt: 1_000,
          mergedAt: 950,
        }),
      ],
    });

    expect(report.pulls.map((entry) => entry.pullRequestNumber)).toEqual([1, 2, 3, 5]);
    expect(report.pulls.map((entry) => entry.readyToFirstReview)).toEqual([10, 20, null, 40]);
    expect(report.pulls.map((entry) => entry.firstReviewToFirstApproval)).toEqual([
      20,
      null,
      10,
      0,
    ]);
    expect(report.pulls.map((entry) => entry.firstApprovalToMerge)).toEqual([40, null, 40, 40]);

    // ready→first review samples: 10, 20, 40. n=3, p50 index 1, p75 index 1.5 → 30.
    expect(report.readyToFirstReview).toEqual({ count: 3, median: 20, p75: 30 });
    // 0, 10, 20. p75 index 1.5 → 15. A missing approval is not a 0.
    expect(report.firstReviewToFirstApproval).toEqual({ count: 3, median: 10, p75: 15 });
    expect(report.firstApprovalToMerge).toEqual({ count: 3, median: 40, p75: 40 });
  });

  it("interpolates an even sample the way Hyndman-Fan type 7 does", () => {
    // Intervals 10, 20, 40, 80. p50 index 1.5 → 30. p75 index 2.25 → 50.
    const report = computeCycleTime({
      pullRequests: [10, 20, 40, 80].map((wait, index) =>
        pull(grace, index + 1, [review(ada, index + 1, 1_000 + wait, "APPROVED")], {
          mergedAt: 1_000 + wait,
        }),
      ),
    });

    expect(report.readyToFirstReview).toEqual({ count: 4, median: 30, p75: 50 });
    expect(report.firstApprovalToMerge).toEqual({ count: 4, median: 0, p75: 0 });
  });

  it("never emits a negative interval, including a single-sample window", () => {
    const report = computeCycleTime({
      pullRequests: [
        pull(grace, 1, [review(ada, 10, 900, "APPROVED")], { readyAt: 1_000, mergedAt: 800 }),
      ],
    });

    expect(report.pulls[0]).toMatchObject({
      readyToFirstReview: null,
      firstReviewToFirstApproval: 0,
      firstApprovalToMerge: null,
    });
    expect(report.readyToFirstReview).toEqual({ count: 0, median: null, p75: null });
    expect(report.firstApprovalToMerge).toEqual({ count: 0, median: null, p75: null });
    expect(report.firstReviewToFirstApproval).toEqual({ count: 1, median: 0, p75: 0 });
  });

  it("starts at createdAt when readyAt is missing, and ignores the author's own reviews", () => {
    const report = computeCycleTime({
      pullRequests: [
        pull(
          grace,
          1,
          [review(grace, 10, 1_010, "APPROVED"), review(ada, 11, 1_050, "CHANGES_REQUESTED")],
          { readyAt: null, createdAt: 1_000, mergedAt: 1_200 },
        ),
      ],
    });

    expect(report.pulls[0]).toMatchObject({
      readyAt: 1_000,
      firstReviewAt: 1_050,
      firstApprovalAt: null,
      readyToFirstReview: 50,
      firstReviewToFirstApproval: null,
      firstApprovalToMerge: null,
    });
    expect(report.readyToFirstReview).toEqual({ count: 1, median: 50, p75: 50 });
    expect(report.firstReviewToFirstApproval.count).toBe(0);
  });

  it("uses the earliest review of any state, even when later rows are sorted first", () => {
    const report = computeCycleTime({
      pullRequests: [
        pull(
          grace,
          1,
          [
            review(ada, 30, 1_300, "APPROVED"),
            review(ada, 10, 1_100, "DISMISSED"),
            review(ada, 20, 1_200, "COMMENTED"),
          ],
          { readyAt: 1_000, mergedAt: 1_500 },
        ),
      ],
    });

    expect(report.pulls[0]).toMatchObject({
      firstReviewAt: 1_100,
      firstApprovalAt: 1_300,
      readyToFirstReview: 100,
      firstReviewToFirstApproval: 200,
      firstApprovalToMerge: 200,
    });
  });

  it("returns empty stats when nothing merged", () => {
    const report = computeCycleTime({ pullRequests: [] });

    expect(report.pulls).toEqual([]);
    expect(report.readyToFirstReview).toEqual({ count: 0, median: null, p75: null });
    expect(report.firstReviewToFirstApproval).toEqual({ count: 0, median: null, p75: null });
    expect(report.firstApprovalToMerge).toEqual({ count: 0, median: null, p75: null });
  });
});
