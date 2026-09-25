import type { MetricPullRequest, MetricUser } from "./loaders.js";

/** Matches `MIN_RECIPROCITY_INTERACTIONS` in config. Callers should pass the configured value. */
export const DEFAULT_MIN_RECIPROCITY_INTERACTIONS = 3;

export type ReciprocityNode = {
  /** Login. Unique in the user table, and the id the graph route can hand to the frontend. */
  id: string;
  githubId: number;
  label: string;
  reviewsGiven: number;
  reviewsReceived: number;
  /**
   * Balance of reviews given vs received: `1 - |given - received| / (given + received)`.
   * 1 is even. 0 is entirely one-way. Only people on at least one edge are emitted, so this is always defined.
   */
  reciprocityScore: number;
};

export type ReciprocityEdge = {
  /** Reviewer login. */
  source: string;
  /** Author login. */
  target: string;
  sourceGithubId: number;
  targetGithubId: number;
  /** Distinct author PRs this reviewer reviewed. Repeat reviews on one PR count once. */
  weight: number;
  reverseWeight: number;
  /** `weight / reverseWeight`. Null when the reverse edge is absent (division by zero). */
  ratio: number | null;
  /** True only for a one-way edge whose weight is at least `minInteractions`. */
  flagged: boolean;
};

export type ReciprocityGraph = {
  minInteractions: number;
  nodes: ReciprocityNode[];
  edges: ReciprocityEdge[];
};

export type BuildReciprocityOptions = {
  minInteractions?: number;
};

type DirectedWeight = {
  reviewer: MetricUser;
  author: MetricUser;
  pullIds: Set<number>;
};

function pairKey(reviewerGithubId: number, authorGithubId: number): string {
  return `${reviewerGithubId}->${authorGithubId}`;
}

function compareLogin(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function balance(given: number, received: number): number {
  const total = given + received;
  return 1 - Math.abs(given - received) / total;
}

/**
 * Directed reviewer → author graph for one already-loaded metric window.
 * Weight is the number of that author's PRs the reviewer reviewed (Project Overview §3.1), not raw review rows.
 * Self-reviews are dropped. Review comments do not create edges. Bots are already gone from the loader.
 */
export function buildReciprocityGraph(
  input: { pullRequests: readonly MetricPullRequest[] },
  options: BuildReciprocityOptions = {},
): ReciprocityGraph {
  const minInteractions = options.minInteractions ?? DEFAULT_MIN_RECIPROCITY_INTERACTIONS;
  const weights = new Map<string, DirectedWeight>();

  for (const pullRequest of input.pullRequests) {
    const seenReviewers = new Set<number>();
    for (const review of pullRequest.reviews) {
      if (review.reviewer.githubId === pullRequest.author.githubId) continue;
      if (seenReviewers.has(review.reviewer.githubId)) continue;
      seenReviewers.add(review.reviewer.githubId);
      const key = pairKey(review.reviewer.githubId, pullRequest.author.githubId);
      const existing = weights.get(key);
      weights.set(key, {
        reviewer: review.reviewer,
        author: pullRequest.author,
        pullIds: new Set([...(existing?.pullIds ?? []), pullRequest.id]),
      });
    }
  }

  const edges = [...weights.values()]
    .map((directed) => {
      const reverse = weights.get(pairKey(directed.author.githubId, directed.reviewer.githubId));
      const weight = directed.pullIds.size;
      const reverseWeight = reverse?.pullIds.size ?? 0;
      return {
        source: directed.reviewer.login,
        target: directed.author.login,
        sourceGithubId: directed.reviewer.githubId,
        targetGithubId: directed.author.githubId,
        weight,
        reverseWeight,
        ratio: reverseWeight === 0 ? null : weight / reverseWeight,
        flagged: reverseWeight === 0 && weight >= minInteractions,
      };
    })
    .sort((left, right) => {
      const bySource = compareLogin(left.source, right.source);
      if (bySource !== 0) return bySource;
      const byTarget = compareLogin(left.target, right.target);
      if (byTarget !== 0) return byTarget;
      return (
        left.sourceGithubId - right.sourceGithubId || left.targetGithubId - right.targetGithubId
      );
    });

  const totals = new Map<number, { user: MetricUser; given: number; received: number }>();
  for (const edge of edges) {
    const reviewer = weights.get(pairKey(edge.sourceGithubId, edge.targetGithubId))?.reviewer;
    const author = weights.get(pairKey(edge.sourceGithubId, edge.targetGithubId))?.author;
    if (!reviewer || !author) continue;
    const given = totals.get(reviewer.githubId) ?? { user: reviewer, given: 0, received: 0 };
    const received = totals.get(author.githubId) ?? { user: author, given: 0, received: 0 };
    totals.set(reviewer.githubId, { ...given, given: given.given + edge.weight });
    totals.set(author.githubId, { ...received, received: received.received + edge.weight });
  }

  const nodes = [...totals.values()]
    .map(({ user, given, received }) => ({
      id: user.login,
      githubId: user.githubId,
      label: user.login,
      reviewsGiven: given,
      reviewsReceived: received,
      reciprocityScore: balance(given, received),
    }))
    .sort((left, right) => compareLogin(left.label, right.label) || left.githubId - right.githubId);

  return { minInteractions, nodes, edges };
}
