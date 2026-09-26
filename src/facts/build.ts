import { compareByCountDesc, type Leaderboards } from "../metrics/leaderboards.js";
import type { CycleTimeReport, CycleTimeStats } from "../metrics/cycletime.js";
import type { LoadBalanceReport } from "../metrics/loadbalance.js";
import type { ReciprocityGraph } from "../metrics/reciprocity.js";
import type { RubberStampReport } from "../metrics/rubberstamp.js";
import type { Fact, FactKind, FactUnit } from "./types.js";

export type BuildFactsInput = {
  reciprocity: ReciprocityGraph;
  rubberStamp: RubberStampReport;
  cycleTime: CycleTimeReport;
  loadBalance: LoadBalanceReport;
  leaderboards: Leaderboards;
};

type IntervalKey = "first_review" | "review_to_approval" | "approval_to_merge";

const CYCLE_INTERVALS: readonly {
  key: IntervalKey;
  label: string;
  stats: (report: CycleTimeReport) => CycleTimeStats;
}[] = [
  {
    key: "first_review",
    label: "ready (or created, when ready is missing) to first non-author review",
    stats: (report) => report.readyToFirstReview,
  },
  {
    key: "review_to_approval",
    label: "first non-author review to first non-author approval",
    stats: (report) => report.firstReviewToFirstApproval,
  },
  {
    key: "approval_to_merge",
    label: "first non-author approval to merge",
    stats: (report) => report.firstApprovalToMerge,
  },
];

const BOARDS: readonly {
  key: keyof Leaderboards;
  unit: FactUnit;
  singular: string;
  plural: string;
}[] = [
  {
    key: "reviewers",
    unit: "reviews",
    singular: "non-self review submission",
    plural: "non-self review submissions",
  },
  {
    key: "authors",
    unit: "pull_requests",
    singular: "authored pull request",
    plural: "authored pull requests",
  },
  {
    key: "closers",
    unit: "pull_requests",
    singular: "merged pull request authored",
    plural: "merged pull requests authored",
  },
];

function fact(
  kind: FactKind,
  subject: string,
  value: number | null,
  unit: FactUnit,
  detail: string,
): Fact {
  return {
    id: `fact:${kind}:${subject}`,
    kind,
    subject,
    value,
    unit,
    detail,
  };
}

function compareLogin(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function byId(left: Fact, right: Fact): number {
  return compareLogin(left.id, right.id);
}

function rubberStampFacts(report: RubberStampReport): Fact[] {
  const reviewers = [...report.reviewers].sort(
    (left, right) =>
      compareLogin(left.reviewer.login, right.reviewer.login) ||
      left.reviewer.githubId - right.reviewer.githubId,
  );
  const pairs = [...report.pairs].sort(
    (left, right) =>
      compareLogin(left.reviewer.login, right.reviewer.login) ||
      compareLogin(left.author.login, right.author.login) ||
      left.reviewer.githubId - right.reviewer.githubId ||
      left.author.githubId - right.author.githubId,
  );
  return [
    ...reviewers.map((row) =>
      fact(
        "rubberstamp",
        row.reviewer.login,
        row.rate,
        "ratio",
        `Rubber-stamp rate for ${row.reviewer.login}: ${row.flagged} of ${row.eligible} eligible approvals ${row.flagged === 1 ? "was" : "were"} faster than ${report.fastApprovalSeconds}s, silent, and larger than ${report.minPrSize} lines.`,
      ),
    ),
    ...pairs.map((row) =>
      fact(
        "rubberstamp",
        `${row.reviewer.login}->${row.author.login}`,
        row.rate,
        "ratio",
        `Rubber-stamp rate for ${row.reviewer.login} approving ${row.author.login}: ${row.flagged} of ${row.eligible} eligible approvals flagged.`,
      ),
    ),
  ];
}

function reciprocityFacts(graph: ReciprocityGraph): Fact[] {
  const edges = [...graph.edges].sort(
    (left, right) =>
      compareLogin(left.source, right.source) ||
      compareLogin(left.target, right.target) ||
      left.sourceGithubId - right.sourceGithubId ||
      left.targetGithubId - right.targetGithubId,
  );
  const nodes = [...graph.nodes].sort(
    (left, right) => compareLogin(left.label, right.label) || left.githubId - right.githubId,
  );
  return [
    ...edges.map((edge) =>
      fact(
        "reciprocity",
        `${edge.source}->${edge.target}`,
        edge.weight,
        "pull_requests",
        `${edge.source} reviewed ${counted(edge.weight, "distinct pull request", "distinct pull requests")} by ${edge.target}; reverse weight ${edge.reverseWeight}; ratio ${edge.ratio === null ? "null" : String(edge.ratio)}; flagged=${edge.flagged}.`,
      ),
    ),
    ...nodes.map((node) =>
      fact(
        "reciprocity",
        node.label,
        node.reciprocityScore,
        "ratio",
        `Reciprocity score for ${node.label}: gave ${node.reviewsGiven}, received ${node.reviewsReceived}. 1 is balanced, 0 is entirely one-way.`,
      ),
    ),
  ];
}

function cycleTimeFacts(report: CycleTimeReport): Fact[] {
  return CYCLE_INTERVALS.flatMap((interval) => {
    const stats = interval.stats(report);
    return [
      fact(
        "cycletime",
        `${interval.key}_p50`,
        stats.median,
        "seconds",
        `Median seconds from ${interval.label}. Null when no merged pull request had this interval. n=${stats.count}.`,
      ),
      fact(
        "cycletime",
        `${interval.key}_p75`,
        stats.p75,
        "seconds",
        `75th percentile seconds from ${interval.label}. Null when no merged pull request had this interval. n=${stats.count}.`,
      ),
      fact(
        "cycletime",
        `${interval.key}_n`,
        stats.count,
        "pull_requests",
        `Merged pull requests with a non-negative ${interval.label} interval.`,
      ),
    ];
  });
}

function loadBalanceFacts(report: LoadBalanceReport): Fact[] {
  return (["reviews", "authorship"] as const).flatMap((activity) => {
    const block = report[activity];
    const noun = activity === "reviews" ? "non-self review submissions" : "authored pull requests";
    return [
      fact(
        "loadbalance",
        `${activity}_gini`,
        block.concentration.gini,
        "ratio",
        `Population Gini of ${noun} across ${block.concentration.population} people, idle teammates included. 0 is uniform. Null when there is nothing to share.`,
      ),
      fact(
        "loadbalance",
        `${activity}_bus_factor`,
        block.busFactor.count,
        "people",
        `Fewest people covering ${report.coverage} of ${noun}. Null when the total is 0.`,
      ),
    ];
  });
}

function leaderboardFacts(boards: Leaderboards): Fact[] {
  return BOARDS.flatMap((board) =>
    [...boards[board.key]].sort(compareByCountDesc).map((entry, index) =>
      fact(
        "leaderboard",
        `${board.key}:${entry.login}`,
        entry.count,
        board.unit,
        `${entry.login} has ${counted(entry.count, board.singular, board.plural)} (position ${index + 1}).`,
      ),
    ),
  );
}

function assertUnique(facts: readonly Fact[]): void {
  const seen = new Set<string>();
  for (const entry of facts) {
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate fact id: ${entry.id}`);
    }
    seen.add(entry.id);
  }
}

/**
 * Flat, citeable facts for one already-computed metric window.
 * Does not re-filter, re-read config, or call GitHub. Row order does not matter.
 *
 * Headline ids:
 * - `fact:rubberstamp:<login>` and `fact:rubberstamp:<reviewer>-><author>` — rate, not each approval
 * - `fact:reciprocity:<source>-><target>` (distinct-PR weight) and `fact:reciprocity:<login>` (score)
 * - `fact:cycletime:first_review_p50` is `readyToFirstReview.median`; siblings are p75, the other two intervals, and sample size
 * - `fact:loadbalance:reviews_gini`, `reviews_bus_factor`, `authorship_gini`, `authorship_bus_factor`
 * - `fact:leaderboard:reviewers|authors|closers:<login>`
 *
 * Cycle-time and load-balance headlines are always present, with null when the sample is empty.
 * Rubber-stamp, reciprocity, and leaderboard facts exist only for rows those metrics emitted.
 */
export function buildFacts(input: BuildFactsInput): Fact[] {
  const facts = [
    ...rubberStampFacts(input.rubberStamp),
    ...reciprocityFacts(input.reciprocity),
    ...cycleTimeFacts(input.cycleTime),
    ...loadBalanceFacts(input.loadBalance),
    ...leaderboardFacts(input.leaderboards),
  ].sort(byId);
  assertUnique(facts);
  return facts;
}
