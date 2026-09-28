import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient, type InsightsResponse } from "../../src/api/client.js";
import { InsightTables } from "../../src/components/InsightTables.js";

const WINDOW = {
  owner: "ada",
  repo: "scope",
  since: "2026-08-29T00:00:00Z",
  until: "2026-09-28T23:59:59Z",
};

function user(id: number, login: string) {
  return { id, githubId: id, login };
}

function rate(flagged: number, eligible: number, rate: number | null) {
  return { flagged, eligible, rate };
}

function stats(count: number, median: number | null, p75: number | null) {
  return { count, median, p75 };
}

function insights(overrides: Partial<InsightsResponse> = {}): InsightsResponse {
  return {
    window: { owner: "ada", repo: "scope", since: 100, until: 200 },
    facts: [],
    leaderboards: { reviewers: [], authors: [], closers: [] },
    cycleTime: {
      pulls: [],
      readyToFirstReview: stats(0, null, null),
      firstReviewToFirstApproval: stats(0, null, null),
      firstApprovalToMerge: stats(0, null, null),
    },
    rubberStamp: {
      fastApprovalSeconds: 300,
      minPrSize: 100,
      approvals: [],
      reviewers: [],
      pairs: [],
    },
    reciprocitySummary: {
      minInteractions: 3,
      nodeCount: 0,
      edgeCount: 0,
      flaggedEdgeCount: 0,
      flaggedEdges: [],
    },
    ...overrides,
  };
}

function renderTables(client: ApiClient, query: typeof WINDOW | null = WINDOW) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InsightTables client={client} window={query} />
    </QueryClientProvider>,
  );
}

describe("InsightTables", () => {
  it("asks for a sync before any window exists", () => {
    renderTables({ insights: vi.fn() } as unknown as ApiClient, null);
    expect(screen.getByText("Sync a repository to load insight tables.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a loading state until the insights payload arrives", () => {
    renderTables({ insights: () => new Promise(() => {}) } as unknown as ApiClient);
    expect(screen.getByText("Loading insights…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders API numbers in API order, including null, without rounding", async () => {
    const payload = insights({
      leaderboards: {
        reviewers: [
          { githubId: 2, login: "bea", count: 1 },
          { githubId: 1, login: "ada", count: 9 },
        ],
        authors: [{ githubId: 1, login: "ada", count: 4 }],
        closers: [{ githubId: 1, login: "ada", count: 3 }],
      },
      rubberStamp: {
        fastApprovalSeconds: 300,
        minPrSize: 100,
        approvals: [],
        reviewers: [
          { reviewer: user(2, "bea"), ...rate(0, 0, null) },
          { reviewer: user(1, "ada"), ...rate(1, 4, 0.25) },
        ],
        pairs: [{ reviewer: user(1, "ada"), author: user(2, "bea"), ...rate(1, 3, 1 / 3) }],
      },
      cycleTime: {
        pulls: [],
        readyToFirstReview: stats(2, 90.5, 120),
        firstReviewToFirstApproval: stats(1, 10, null),
        firstApprovalToMerge: stats(1, 0, 0),
      },
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    const reviewerLogins = within(reviewers)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(reviewerLogins).toEqual(["bea", "ada"]);
    expect(document.getElementById("fact:leaderboard:reviewers:ada")?.textContent).toBe("9");
    expect(document.getElementById("fact:leaderboard:authors:ada")?.textContent).toBe("4");
    expect(document.getElementById("fact:leaderboard:closers:ada")?.textContent).toBe("3");

    expect(document.getElementById("fact:rubberstamp:bea")?.textContent).toBe("null");
    expect(document.getElementById("fact:rubberstamp:ada")?.textContent).toBe("0.25");
    expect(document.getElementById("fact:rubberstamp:ada->bea")?.textContent).toBe(String(1 / 3));
    expect(screen.getByText("Fast approval under 300s. Minimum PR size 100 lines.")).toBeTruthy();

    expect(document.getElementById("fact:cycletime:first_review_p50")?.textContent).toBe("90.5");
    expect(document.getElementById("fact:cycletime:first_review_p75")?.textContent).toBe("120");
    expect(document.getElementById("fact:cycletime:first_review_n")?.textContent).toBe("2");
    expect(document.getElementById("fact:cycletime:review_to_approval_p75")?.textContent).toBe(
      "null",
    );
    expect(document.getElementById("fact:cycletime:approval_to_merge_p50")?.textContent).toBe("0");
    expect(screen.getByText("ada/scope · 100–200")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Pull requests" })).toBeNull();
  });

  it("says the window is empty when every board and interval has no rows", async () => {
    renderTables({ insights: async () => insights() } as unknown as ApiClient);
    expect(await screen.findByText("No review activity in this window.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps an empty board visible when another board has rows", async () => {
    renderTables({
      insights: async () =>
        insights({
          leaderboards: {
            reviewers: [],
            authors: [{ githubId: 1, login: "ada", count: 1 }],
            closers: [],
          },
        }),
    } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    expect(within(reviewers).getByText("None in this window.")).toBeTruthy();
    expect(document.getElementById("fact:leaderboard:authors:ada")?.textContent).toBe("1");
  });

  it("shows the API message when insights fail", async () => {
    renderTables({
      insights: async () => {
        throw new ApiError(404, "Repository not found", {
          status: 404,
          error: "Not Found",
          message: "Repository not found",
        });
      },
    } as unknown as ApiClient);
    expect(await screen.findByText("Repository not found")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
