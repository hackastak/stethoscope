import { describe, expect, it } from "vitest";
import type {
  MetricComment,
  MetricPullRequest,
  MetricReview,
  MetricUser,
} from "../../src/metrics/loaders.js";
import { buildReciprocityGraph } from "../../src/metrics/reciprocity.js";

function user(githubId: number, login: string): MetricUser {
  return { id: githubId, githubId, login };
}

function review(
  reviewer: MetricUser,
  githubId: number,
  state: MetricReview["state"] = "APPROVED",
): MetricReview {
  return {
    id: githubId,
    githubId,
    state,
    submittedAt: 1,
    bodyLen: 0,
    commentCount: 0,
    reviewer,
  };
}

function comment(reviewer: MetricUser, githubId: number): MetricComment {
  return { id: githubId, githubId, createdAt: 1, reviewer };
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
    state: "open",
    createdAt: 1,
    readyAt: null,
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 1,
    changedFiles: 1,
    lastCommitAt: 1,
    author,
    reviews,
    comments,
  };
}

const ada = user(1, "ada");
const grace = user(2, "grace");
const linus = user(3, "linus");

describe("buildReciprocityGraph", () => {
  it("excludes self-reviews from edges, weights, and scores", () => {
    const graph = buildReciprocityGraph({
      pullRequests: [
        pull(ada, 1, [review(ada, 10), review(ada, 11), review(grace, 12)]),
        pull(ada, 2, [review(ada, 13)]),
      ],
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: "grace",
        target: "ada",
        weight: 1,
        reverseWeight: 0,
      }),
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["ada", "grace"]);
    expect(graph.nodes.find((node) => node.id === "grace")).toMatchObject({
      reviewsGiven: 1,
      reviewsReceived: 0,
    });
    expect(graph.nodes.find((node) => node.id === "ada")).toMatchObject({
      reviewsGiven: 0,
      reviewsReceived: 1,
    });
  });

  it("scores symmetric collaboration at 1 and does not flag it", () => {
    const graph = buildReciprocityGraph(
      {
        pullRequests: [
          pull(grace, 1, [review(ada, 10)]),
          pull(grace, 2, [review(ada, 11, "COMMENTED")]),
          pull(ada, 3, [review(grace, 12, "CHANGES_REQUESTED")]),
          pull(ada, 4, [review(grace, 13, "DISMISSED")]),
        ],
      },
      { minInteractions: 3 },
    );

    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: "ada",
        target: "grace",
        weight: 2,
        reverseWeight: 2,
        ratio: 1,
        flagged: false,
      }),
      expect.objectContaining({
        source: "grace",
        target: "ada",
        weight: 2,
        reverseWeight: 2,
        ratio: 1,
        flagged: false,
      }),
    ]);
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "ada",
        reviewsGiven: 2,
        reviewsReceived: 2,
        reciprocityScore: 1,
      }),
      expect.objectContaining({
        id: "grace",
        reviewsGiven: 2,
        reviewsReceived: 2,
        reciprocityScore: 1,
      }),
    ]);
  });

  it("flags a one-way edge at the threshold and leaves the ratio undefined", () => {
    const graph = buildReciprocityGraph(
      {
        pullRequests: [1, 2, 3].map((number) => pull(grace, number, [review(ada, number)])),
      },
      { minInteractions: 3 },
    );

    expect(graph.edges).toEqual([
      {
        source: "ada",
        target: "grace",
        sourceGithubId: 1,
        targetGithubId: 2,
        weight: 3,
        reverseWeight: 0,
        ratio: null,
        flagged: true,
      },
    ]);
    expect(graph.nodes).toEqual([
      expect.objectContaining({ id: "ada", reciprocityScore: 0 }),
      expect.objectContaining({ id: "grace", reciprocityScore: 0 }),
    ]);
  });

  it("does not flag a one-way pair below the minimum interactions", () => {
    const graph = buildReciprocityGraph(
      {
        pullRequests: [1, 2].map((number) => pull(grace, number, [review(ada, number)])),
      },
      { minInteractions: 3 },
    );

    expect(graph.edges[0]).toMatchObject({
      weight: 2,
      reverseWeight: 0,
      flagged: false,
      ratio: null,
    });
    expect(graph.minInteractions).toBe(3);
  });

  it("does not flag a mutual pair, even when the ratio is lopsided", () => {
    const graph = buildReciprocityGraph(
      {
        pullRequests: [
          ...[1, 2, 3, 4, 5, 6].map((number) => pull(grace, number, [review(ada, number)])),
          pull(ada, 7, [review(grace, 70)]),
          pull(ada, 8, [review(grace, 80)]),
        ],
      },
      { minInteractions: 3 },
    );

    const adaToGrace = graph.edges.find((edge) => edge.source === "ada" && edge.target === "grace");
    const graceToAda = graph.edges.find((edge) => edge.source === "grace" && edge.target === "ada");
    expect(adaToGrace).toMatchObject({ weight: 6, reverseWeight: 2, ratio: 3, flagged: false });
    expect(graceToAda).toMatchObject({ weight: 2, reverseWeight: 6, ratio: 1 / 3, flagged: false });
    expect(graph.nodes.find((node) => node.id === "ada")?.reciprocityScore).toBe(0.5);
  });

  it("counts each author PR once and ignores review comments that are not reviews", () => {
    const graph = buildReciprocityGraph({
      pullRequests: [
        pull(
          grace,
          1,
          [review(ada, 10, "COMMENTED"), review(ada, 11, "APPROVED")],
          [comment(linus, 90)],
        ),
      ],
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "ada", target: "grace", weight: 1 }),
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["ada", "grace"]);
  });

  it("returns an empty graph for a window with no cross-reviews", () => {
    const graph = buildReciprocityGraph({ pullRequests: [pull(ada, 1, [review(ada, 10)])] });

    expect(graph).toEqual({ minInteractions: 3, nodes: [], edges: [] });
  });

  it("orders nodes and edges deterministically", () => {
    const graph = buildReciprocityGraph({
      pullRequests: [pull(linus, 1, [review(grace, 10)]), pull(ada, 2, [review(linus, 11)])],
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(["ada", "grace", "linus"]);
    expect(graph.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      "grace->linus",
      "linus->ada",
    ]);
  });
});
