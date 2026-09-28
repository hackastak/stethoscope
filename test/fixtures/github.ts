/**
 * Wire-shaped GitHub payloads for the T32 flow.
 * Epochs are the instants below. Expected fact values are hand-checked, not computed by the app.
 *
 * Window: 2024-01-01T00:00:00Z .. 2024-01-31T23:59:59Z.
 * #1 was closed in 2023 and only updated inside the window, so sync must not store it.
 * #7 is ada's only merged PR. Grace approves 120s after the last commit, with no comments, on 160 lines.
 * #8 and #9 stay open so grace → ada reaches weight 3. dependabot[bot] comments on #8 and must not become a fact.
 */

export const FIXTURE_OWNER = "acme";
export const FIXTURE_REPO = "widgets";
export const FIXTURE_SINCE_ISO = "2024-01-01T00:00:00Z";
export const FIXTURE_UNTIL_ISO = "2024-01-31T23:59:59Z";
export const FIXTURE_SINCE = 1_704_067_200;
export const FIXTURE_UNTIL = 1_706_745_599;

const ADA = { id: 11, login: "ada", type: "User" };
const GRACE = { id: 22, login: "grace", type: "User" };
const BOT = { id: 99, login: "dependabot[bot]", type: "Bot" };

export const userRepos = [
  {
    name: "widgets",
    full_name: "acme/widgets",
    private: false,
    visibility: "public",
    default_branch: "main",
    pushed_at: "2024-01-20T00:00:00Z",
    owner: { login: "acme" },
  },
  {
    name: "secret",
    full_name: "acme/secret",
    private: true,
    visibility: "private",
    default_branch: "trunk",
    pushed_at: "2024-01-01T00:00:00Z",
    owner: { login: "acme" },
  },
];

export const normalizedUserRepos = [
  {
    owner: "acme",
    name: "widgets",
    fullName: "acme/widgets",
    visibility: "public",
    defaultBranch: "main",
    pushedAt: 1_705_708_800,
  },
  {
    owner: "acme",
    name: "secret",
    fullName: "acme/secret",
    visibility: "private",
    defaultBranch: "trunk",
    pushedAt: 1_704_067_200,
  },
];

/** Listed newest-updated first. #1 does not overlap the window. */
export const listedPulls = [
  {
    number: 1,
    updated_at: "2024-01-20T00:00:00Z",
    created_at: "2023-11-01T00:00:00Z",
    closed_at: "2023-12-01T00:00:00Z",
    merged_at: "2023-12-01T00:00:00Z",
  },
  {
    number: 9,
    updated_at: "2024-01-04T01:00:00Z",
    created_at: "2024-01-04T00:00:00Z",
    closed_at: null,
    merged_at: null,
  },
  {
    number: 8,
    updated_at: "2024-01-03T00:10:00Z",
    created_at: "2024-01-03T00:00:00Z",
    closed_at: null,
    merged_at: null,
  },
  {
    number: 7,
    updated_at: "2024-01-02T02:00:00Z",
    created_at: "2024-01-02T00:00:00Z",
    closed_at: "2024-01-02T02:00:00Z",
    merged_at: "2024-01-02T02:00:00Z",
  },
];

const details: Record<number, unknown> = {
  7: {
    id: 1007,
    number: 7,
    state: "closed",
    created_at: "2024-01-02T00:00:00Z",
    closed_at: "2024-01-02T02:00:00Z",
    merged_at: "2024-01-02T02:00:00Z",
    additions: 150,
    deletions: 10,
    changed_files: 4,
    user: ADA,
  },
  8: {
    id: 1008,
    number: 8,
    state: "open",
    created_at: "2024-01-03T00:00:00Z",
    closed_at: null,
    merged_at: null,
    additions: 20,
    deletions: 0,
    changed_files: 1,
    user: ADA,
  },
  9: {
    id: 1009,
    number: 9,
    state: "open",
    created_at: "2024-01-04T00:00:00Z",
    closed_at: null,
    merged_at: null,
    additions: 30,
    deletions: 0,
    changed_files: 1,
    user: ADA,
  },
};

const commits: Record<number, unknown[]> = {
  7: [{ commit: { committer: { date: "2024-01-02T01:00:00Z" } } }],
  8: [{ commit: { committer: { date: "2024-01-03T00:00:00Z" } } }],
  9: [{ commit: { committer: { date: "2024-01-04T00:30:00Z" } } }],
};

const reviews: Record<number, unknown[]> = {
  7: [
    {
      id: 701,
      state: "APPROVED",
      submitted_at: "2024-01-02T01:02:00Z",
      body: "",
      user: GRACE,
    },
  ],
  8: [
    {
      id: 801,
      state: "COMMENTED",
      submitted_at: "2024-01-03T00:10:00Z",
      body: "question",
      user: GRACE,
    },
    {
      id: 802,
      state: "COMMENTED",
      submitted_at: "2024-01-03T00:12:00Z",
      body: "dependency bump",
      user: BOT,
    },
  ],
  9: [
    {
      id: 901,
      state: "CHANGES_REQUESTED",
      submitted_at: "2024-01-04T01:00:00Z",
      body: "rename this",
      user: GRACE,
    },
  ],
};

const comments: Record<number, unknown[]> = {
  7: [],
  8: [
    {
      id: 8801,
      pull_request_review_id: 801,
      created_at: "2024-01-03T00:11:00Z",
      user: GRACE,
    },
  ],
  9: [],
};

export function pullDetail(number: number): unknown {
  return details[number];
}

export function pullCommits(number: number): unknown[] | undefined {
  return commits[number];
}

export function pullReviews(number: number): unknown[] | undefined {
  return reviews[number];
}

export function pullComments(number: number): unknown[] | undefined {
  return comments[number];
}

/**
 * #7 approval is 120s after the last commit, silent, and 160 lines, so grace's rate is 1/1.
 * Cycle time falls back to created_at: 3720s to that review, 0s review-to-approval, 3480s to merge.
 * Reviews Gini of [grace 3, ada 0] is 0.5. Bus factor at 0.5 coverage is 1. Authorship is the mirror.
 */
export const expectedFactValues: Record<string, number> = {
  "fact:cycletime:approval_to_merge_n": 1,
  "fact:cycletime:approval_to_merge_p50": 3480,
  "fact:cycletime:approval_to_merge_p75": 3480,
  "fact:cycletime:first_review_n": 1,
  "fact:cycletime:first_review_p50": 3720,
  "fact:cycletime:first_review_p75": 3720,
  "fact:cycletime:review_to_approval_n": 1,
  "fact:cycletime:review_to_approval_p50": 0,
  "fact:cycletime:review_to_approval_p75": 0,
  "fact:leaderboard:authors:ada": 3,
  "fact:leaderboard:closers:ada": 1,
  "fact:leaderboard:reviewers:grace": 3,
  "fact:loadbalance:authorship_bus_factor": 1,
  "fact:loadbalance:authorship_gini": 0.5,
  "fact:loadbalance:reviews_bus_factor": 1,
  "fact:loadbalance:reviews_gini": 0.5,
  "fact:reciprocity:ada": 0,
  "fact:reciprocity:grace": 0,
  "fact:reciprocity:grace->ada": 3,
  "fact:rubberstamp:grace": 1,
  "fact:rubberstamp:grace->ada": 1,
};

export const storedPullNumbers = [7, 8, 9];
export const storedReviewCount = 4;
export const storedCommentCount = 1;
export const storedUserCount = 3;
