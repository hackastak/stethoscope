import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** A leaderboard of `size` rows, counts descending so login `userN` has a predictable count. */
function board(size: number) {
  return Array.from({ length: size }, (_, index) => ({
    githubId: index + 1,
    login: `user${index + 1}`,
    count: size - index,
  }));
}

function dataRows(table: HTMLElement) {
  return within(table).getAllByRole("row").slice(1);
}

/** `size` rubber-stamp-by-reviewer rows with distinct logins and rates. */
function reviewerRates(size: number) {
  return Array.from({ length: size }, (_, index) => ({
    reviewer: user(index + 1, `rev${index + 1}`),
    ...rate(index, index + 1, index / (index + 1)),
  }));
}

function rubberStamp(overrides: Partial<InsightsResponse["rubberStamp"]> = {}) {
  return {
    fastApprovalSeconds: 300,
    minPrSize: 100,
    approvals: [],
    reviewers: [],
    pairs: [],
    ...overrides,
  };
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
    // The section has a visible heading, consistent with the other cards (N5).
    expect(screen.getByRole("heading", { name: "Insights" })).toBeTruthy();
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

  it("collapses a long board to its top five and offers a See More toggle", async () => {
    const payload = insights({
      leaderboards: {
        reviewers: board(8),
        authors: [{ githubId: 1, login: "ada", count: 4 }],
        closers: [],
      },
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    expect(dataRows(reviewers)).toHaveLength(5);
    // The sixth-and-beyond rows are not rendered while collapsed.
    expect(document.getElementById("fact:leaderboard:reviewers:user6")).toBeNull();
    // Only the board over the cap gets a toggle; the short board does not.
    expect(screen.getAllByRole("button", { name: "See More" })).toHaveLength(1);
  });

  it("does not add a toggle when a board is at or under five rows", async () => {
    const payload = insights({
      leaderboards: { reviewers: board(5), authors: [], closers: [] },
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    expect(dataRows(reviewers)).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "See More" })).toBeNull();
  });

  it("expands to every row on See More and collapses again on See Less", async () => {
    const payload = insights({
      leaderboards: { reviewers: board(8), authors: [], closers: [] },
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    await userEvent.click(screen.getByRole("button", { name: "See More" }));

    expect(dataRows(reviewers)).toHaveLength(8);
    expect(document.getElementById("fact:leaderboard:reviewers:user8")?.textContent).toBe("1");

    const collapse = screen.getByRole("button", { name: "See Less" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(collapse);

    expect(dataRows(reviewers)).toHaveLength(5);
    expect(screen.getByRole("button", { name: "See More" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("tracks expand state independently per board", async () => {
    const payload = insights({
      leaderboards: { reviewers: board(8), authors: board(7), closers: [] },
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const reviewers = await screen.findByRole("table", { name: "Top reviewers" });
    const authors = screen.getByRole("table", { name: "Top authors" });

    // Expanding reviewers must not expand authors.
    await userEvent.click(within(reviewers.closest(".board")!).getByRole("button"));

    expect(dataRows(reviewers)).toHaveLength(8);
    expect(dataRows(authors)).toHaveLength(5);
    expect(within(authors.closest(".board")!).getByRole("button").textContent).toBe("See More");
  });

  it("collapses a long rubber-stamp table and expands it on See More", async () => {
    const payload = insights({
      rubberStamp: rubberStamp({ reviewers: reviewerRates(8) }),
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const table = await screen.findByRole("table", { name: "Rubber-stamp rates by reviewer" });
    expect(dataRows(table)).toHaveLength(5);
    expect(document.getElementById("fact:rubberstamp:rev8")).toBeNull();
    // Only the board over the cap has a toggle (the empty pair table has none).
    expect(screen.getAllByRole("button", { name: "See More" })).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "See More" }));
    expect(dataRows(table)).toHaveLength(8);
    expect(document.getElementById("fact:rubberstamp:rev8")?.textContent).toBe(String(7 / 8));

    await userEvent.click(screen.getByRole("button", { name: "See Less" }));
    expect(dataRows(table)).toHaveLength(5);
  });

  it("leaves a short rubber-stamp table untoggled", async () => {
    const payload = insights({
      rubberStamp: rubberStamp({ reviewers: reviewerRates(5) }),
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const table = await screen.findByRole("table", { name: "Rubber-stamp rates by reviewer" });
    expect(dataRows(table)).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "See More" })).toBeNull();
  });

  it("describes the Flagged, Eligible, and Rate columns with an accessible tooltip", async () => {
    const payload = insights({
      rubberStamp: rubberStamp({ reviewers: reviewerRates(1) }),
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const table = await screen.findByRole("table", { name: "Rubber-stamp rates by reviewer" });

    // The tooltip lives on a dedicated info button, separate from the sort button.
    const flaggedInfo = within(table).getByRole("button", { name: "About Flagged" });
    const flaggedTipId = flaggedInfo.getAttribute("aria-describedby");
    expect(flaggedTipId).toBeTruthy();
    const flaggedTip = document.getElementById(flaggedTipId as string);
    expect(flaggedTip?.getAttribute("role")).toBe("tooltip");
    expect(flaggedTip?.textContent).toContain("look like rubber-stamps");
    expect(flaggedInfo.querySelector("svg[aria-hidden='true']")).not.toBeNull();

    const eligibleTipId = within(table)
      .getByRole("button", { name: "About Eligible" })
      .getAttribute("aria-describedby");
    expect(document.getElementById(eligibleTipId as string)?.textContent).toContain("denominator");

    const rateTipId = within(table)
      .getByRole("button", { name: "About Rate" })
      .getAttribute("aria-describedby");
    expect(document.getElementById(rateTipId as string)?.textContent).toContain(
      "Flagged divided by Eligible",
    );

    // The sort buttons carry no tooltip, and "Who" has no info button at all.
    expect(
      within(table).getByRole("button", { name: "Flagged" }).getAttribute("aria-describedby"),
    ).toBeNull();
    expect(within(table).queryByRole("button", { name: "About Who" })).toBeNull();

    // Opens only from the info button: hover, then unhover, then keyboard focus + Escape.
    expect(flaggedTip?.getAttribute("data-open")).toBe("false");
    await userEvent.hover(flaggedInfo);
    expect(flaggedTip?.getAttribute("data-open")).toBe("true");
    await userEvent.unhover(flaggedInfo);
    expect(flaggedTip?.getAttribute("data-open")).toBe("false");

    fireEvent.focus(flaggedInfo);
    expect(flaggedTip?.getAttribute("data-open")).toBe("true");
    fireEvent.keyDown(flaggedInfo, { key: "Escape" });
    expect(flaggedTip?.getAttribute("data-open")).toBe("false");

    // Clicking the column header to sort must NOT open the tooltip.
    await userEvent.click(within(table).getByRole("button", { name: "Flagged" }));
    expect(flaggedTip?.getAttribute("data-open")).toBe("false");
  });

  it("sorts a rubber-stamp table by the clicked column, toggling direction", async () => {
    const payload = insights({
      rubberStamp: rubberStamp({
        reviewers: [
          { reviewer: user(1, "ada"), ...rate(2, 10, 0.2) },
          { reviewer: user(2, "bob"), ...rate(8, 8, 1) },
          { reviewer: user(3, "cyd"), ...rate(5, 9, 5 / 9) },
        ],
      }),
    });
    renderTables({ insights: async () => payload } as unknown as ApiClient);

    const table = await screen.findByRole("table", { name: "Rubber-stamp rates by reviewer" });
    const logins = () =>
      dataRows(table).map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    const headerCell = (name: string) =>
      within(table).getByRole("button", { name }).closest("th");

    // Untouched: rows stay in the order the API returned them, nothing marked sorted.
    expect(logins()).toEqual(["ada", "bob", "cyd"]);
    expect(headerCell("Flagged")?.getAttribute("aria-sort")).toBe("none");

    // Click Flagged → flagged descending (largest first).
    await userEvent.click(within(table).getByRole("button", { name: "Flagged" }));
    expect(logins()).toEqual(["bob", "cyd", "ada"]);
    expect(headerCell("Flagged")?.getAttribute("aria-sort")).toBe("descending");

    // Click Flagged again → toggles to ascending.
    await userEvent.click(within(table).getByRole("button", { name: "Flagged" }));
    expect(logins()).toEqual(["ada", "cyd", "bob"]);
    expect(headerCell("Flagged")?.getAttribute("aria-sort")).toBe("ascending");

    // Switch to Rate → descending; the previous column resets to unsorted.
    await userEvent.click(within(table).getByRole("button", { name: "Rate" }));
    expect(logins()).toEqual(["bob", "cyd", "ada"]);
    expect(headerCell("Rate")?.getAttribute("aria-sort")).toBe("descending");
    expect(headerCell("Flagged")?.getAttribute("aria-sort")).toBe("none");

    // Text column leads A–Z.
    await userEvent.click(within(table).getByRole("button", { name: "Who" }));
    expect(logins()).toEqual(["ada", "bob", "cyd"]);
    expect(headerCell("Who")?.getAttribute("aria-sort")).toBe("ascending");
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
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Repository not found");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
