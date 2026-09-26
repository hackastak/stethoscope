import { describe, expect, it } from "vitest";
import { buildFacts, type BuildFactsInput } from "../../src/facts/build.js";
import type { Fact } from "../../src/facts/types.js";
import { computeCycleTime } from "../../src/metrics/cycletime.js";
import { buildLeaderboards } from "../../src/metrics/leaderboards.js";
import { computeLoadBalance } from "../../src/metrics/loadbalance.js";
import type { MetricPullRequest, MetricReview, MetricUser } from "../../src/metrics/loaders.js";
import { buildReciprocityGraph } from "../../src/metrics/reciprocity.js";
import { detectRubberStamps } from "../../src/metrics/rubberstamp.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(
  reviewer: MetricUser,
  githubId: number,
  submittedAt: number,
  state: MetricReview["state"] = "APPROVED",
  commentCount = 0,
): MetricReview {
  return {
    id: githubId,
    githubId,
    state,
    submittedAt,
    bodyLen: 0,
    commentCount,
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
    additions: 80,
    deletions: 40,
    changedFiles: 2,
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
const idle = user(4, "idle");

/**
 * ada rubber-stamps one of two eligible approvals of grace, and reviews her a third time
 * without a reverse edge (flagged at the default threshold of 3).
 * grace approves linus once, with comments, so the rate is a real zero.
 * idle only comments, so they sit in the Gini population and on no board.
 */
function windowPulls(): MetricPullRequest[] {
  return [
    pull(grace, 1, [review(ada, 11, 1_010)], {
      mergedAt: 2_000,
      comments: [{ id: 90, githubId: 90, createdAt: 1_050, reviewer: idle }],
    }),
    pull(grace, 2, [review(ada, 21, 1_020)], {
      mergedAt: 1_300,
      additions: 4,
      deletions: 1,
    }),
    pull(linus, 3, [review(grace, 31, 1_100, "APPROVED", 2)], {
      mergedAt: 1_400,
      additions: 150,
      deletions: 50,
    }),
    pull(grace, 4, [review(ada, 41, 1_500, "COMMENTED")], {
      state: "open",
      mergedAt: null,
      closedAt: null,
    }),
  ];
}

function fromPulls(pullRequests: readonly MetricPullRequest[]): BuildFactsInput {
  return {
    reciprocity: buildReciprocityGraph({ pullRequests }),
    rubberStamp: detectRubberStamps({ pullRequests }),
    cycleTime: computeCycleTime({ pullRequests }),
    loadBalance: computeLoadBalance({ pullRequests }),
    leaderboards: buildLeaderboards({ pullRequests }),
  };
}

function reversed<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

function reverseInput(input: BuildFactsInput): BuildFactsInput {
  return {
    reciprocity: {
      ...input.reciprocity,
      nodes: reversed(input.reciprocity.nodes),
      edges: reversed(input.reciprocity.edges),
    },
    rubberStamp: {
      ...input.rubberStamp,
      approvals: reversed(input.rubberStamp.approvals),
      reviewers: reversed(input.rubberStamp.reviewers),
      pairs: reversed(input.rubberStamp.pairs),
    },
    cycleTime: { ...input.cycleTime, pulls: reversed(input.cycleTime.pulls) },
    loadBalance: {
      ...input.loadBalance,
      reviews: {
        ...input.loadBalance.reviews,
        distribution: reversed(input.loadBalance.reviews.distribution),
      },
      authorship: {
        ...input.loadBalance.authorship,
        distribution: reversed(input.loadBalance.authorship.distribution),
      },
    },
    leaderboards: {
      reviewers: reversed(input.leaderboards.reviewers),
      authors: reversed(input.leaderboards.authors),
      closers: reversed(input.leaderboards.closers),
    },
  };
}

const EMPTY_HEADLINES = [
  "fact:cycletime:approval_to_merge_n",
  "fact:cycletime:approval_to_merge_p50",
  "fact:cycletime:approval_to_merge_p75",
  "fact:cycletime:first_review_n",
  "fact:cycletime:first_review_p50",
  "fact:cycletime:first_review_p75",
  "fact:cycletime:review_to_approval_n",
  "fact:cycletime:review_to_approval_p50",
  "fact:cycletime:review_to_approval_p75",
  "fact:loadbalance:authorship_bus_factor",
  "fact:loadbalance:authorship_gini",
  "fact:loadbalance:reviews_bus_factor",
  "fact:loadbalance:reviews_gini",
];

function byId(facts: readonly Fact[], id: string): Fact {
  const found = facts.find((fact) => fact.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("buildFacts", () => {
  const input = fromPulls(windowPulls());
  const facts = buildFacts(input);

  it("is deterministic: same rows in any order produce the same facts, sorted by id", () => {
    expect(buildFacts(input)).toEqual(facts);
    expect(buildFacts(reverseInput(input))).toEqual(facts);
    expect(facts.map((fact) => fact.id)).toEqual([...facts.map((fact) => fact.id)].sort());
  });

  it("gives every fact a unique id of the form fact:<kind>:<subject>", () => {
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(facts.length);
    for (const fact of facts) {
      expect(fact.id).toBe(`fact:${fact.kind}:${fact.subject}`);
      expect(fact.detail.length).toBeGreaterThan(0);
    }
  });

  it("surfaces each metric's headline, with cycle-time p50 reading the type-7 median", () => {
    expect(byId(facts, "fact:cycletime:first_review_p50")).toMatchObject({
      kind: "cycletime",
      subject: "first_review_p50",
      value: input.cycleTime.readyToFirstReview.median,
      unit: "seconds",
    });
    expect(byId(facts, "fact:cycletime:first_review_p50").value).toBe(20);
    expect(byId(facts, "fact:cycletime:first_review_p75").value).toBe(
      input.cycleTime.readyToFirstReview.p75,
    );
    expect(byId(facts, "fact:cycletime:review_to_approval_p50").value).toBe(0);
    expect(byId(facts, "fact:cycletime:approval_to_merge_p50").value).toBe(
      input.cycleTime.firstApprovalToMerge.median,
    );

    expect(byId(facts, "fact:rubberstamp:ada")).toMatchObject({
      kind: "rubberstamp",
      subject: "ada",
      value: 0.5,
      unit: "ratio",
    });
    expect(byId(facts, "fact:rubberstamp:ada->grace").value).toBe(0.5);
    expect(byId(facts, "fact:rubberstamp:grace").value).toBe(0);

    expect(byId(facts, "fact:reciprocity:ada->grace")).toMatchObject({
      kind: "reciprocity",
      subject: "ada->grace",
      value: 3,
      unit: "pull_requests",
    });
    expect(byId(facts, "fact:reciprocity:ada->grace").detail).toContain("flagged=true");
    expect(byId(facts, "fact:reciprocity:grace->linus").detail).toContain("flagged=false");
    expect(byId(facts, "fact:reciprocity:grace")).toMatchObject({
      subject: "grace",
      value: 0.5,
      unit: "ratio",
    });

    expect(byId(facts, "fact:loadbalance:reviews_gini").value).toBe(
      input.loadBalance.reviews.concentration.gini,
    );
    expect(byId(facts, "fact:loadbalance:reviews_bus_factor").value).toBe(1);
    expect(byId(facts, "fact:loadbalance:authorship_bus_factor").value).toBe(1);
    expect(byId(facts, "fact:loadbalance:reviews_gini").value).toBe(0.625);

    expect(byId(facts, "fact:leaderboard:reviewers:ada")).toMatchObject({
      value: 3,
      unit: "reviews",
    });
    expect(byId(facts, "fact:leaderboard:authors:grace").value).toBe(3);
    expect(byId(facts, "fact:leaderboard:closers:grace").value).toBe(2);
    expect(facts.some((fact) => fact.subject.includes("idle"))).toBe(false);
  });

  it("still emits cycle-time and load-balance headlines when the window is empty", () => {
    const empty = buildFacts(fromPulls([]));
    expect(empty.map((fact) => fact.id)).toEqual(EMPTY_HEADLINES);
    expect(byId(empty, "fact:cycletime:first_review_p50").value).toBeNull();
    expect(byId(empty, "fact:cycletime:first_review_n").value).toBe(0);
    expect(byId(empty, "fact:loadbalance:reviews_gini").value).toBeNull();
    expect(byId(empty, "fact:loadbalance:reviews_bus_factor").value).toBeNull();
    expect(empty.some((fact) => fact.kind === "rubberstamp" || fact.kind === "reciprocity")).toBe(
      false,
    );
  });

  it("rejects a response whose ids would collide", () => {
    const empty = fromPulls([]);
    expect(() =>
      buildFacts({
        ...empty,
        rubberStamp: {
          ...empty.rubberStamp,
          reviewers: [
            {
              reviewer: { id: 1, githubId: 1, login: "ada->grace" },
              flagged: 1,
              eligible: 1,
              rate: 1,
            },
          ],
          pairs: [
            {
              reviewer: { id: 1, githubId: 1, login: "ada" },
              author: { id: 2, githubId: 2, login: "grace" },
              flagged: 1,
              eligible: 1,
              rate: 1,
            },
          ],
        },
      }),
    ).toThrow("Duplicate fact id: fact:rubberstamp:ada->grace");
  });

  it("matches the snapshot", () => {
    expect(facts).toMatchSnapshot();
  });
});
