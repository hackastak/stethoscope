import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type ApiClient,
  type NarrativeResponse,
  type WindowQuery,
} from "../../src/api/client.js";
import { InsightTables } from "../../src/components/InsightTables.js";
import { isTableFact, NarrativePanel } from "../../src/components/NarrativePanel.js";
import type { InsightsResponse } from "../../src/api/client.js";

const WINDOW = {
  owner: "ada",
  repo: "scope",
  since: "2026-08-29T00:00:00Z",
  until: "2026-09-28T23:59:59Z",
};

function narrative(overrides: Partial<NarrativeResponse> = {}): NarrativeResponse {
  return {
    window: { owner: "ada", repo: "scope", since: 100, until: 200 },
    narrative: "Reviews pile up.",
    hypothesis: "One reviewer is carrying the queue.",
    confidence: 0.7,
    evidence: [{ id: "fact:leaderboard:reviewers:ada", value: 9 }],
    ...overrides,
  };
}

function insights(): InsightsResponse {
  return {
    window: { owner: "ada", repo: "scope", since: 100, until: 200 },
    facts: [],
    leaderboards: {
      reviewers: [{ githubId: 1, login: "ada", count: 9 }],
      authors: [],
      closers: [],
    },
    cycleTime: {
      pulls: [],
      readyToFirstReview: { count: 1, median: 90.5, p75: null },
      firstReviewToFirstApproval: { count: 0, median: null, p75: null },
      firstApprovalToMerge: { count: 0, median: null, p75: null },
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
  };
}

function renderPanel(client: ApiClient, query: WindowQuery | null = WINDOW) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (next: WindowQuery | null) => (
    <QueryClientProvider client={queryClient}>
      <NarrativePanel client={client} window={next} />
    </QueryClientProvider>
  );
  const view = render(ui(query));
  return { ...view, setWindow: (next: WindowQuery | null) => view.rerender(ui(next)) };
}

describe("NarrativePanel", () => {
  it("does not call the API until a window exists and the button is clicked", async () => {
    const user = userEvent.setup();
    const post = vi.fn(async () => narrative());
    renderPanel({ narrative: post } as unknown as ApiClient, null);

    const button = screen.getByRole("button", { name: "Write narrative" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sync a repository before asking for a narrative.")).toBeTruthy();
    await user.click(button);
    expect(post).not.toHaveBeenCalled();
  });

  it("shows a pending state and does not post twice while the call is in flight", async () => {
    const user = userEvent.setup();
    const post = vi.fn(() => new Promise<NarrativeResponse>(() => {}));
    renderPanel({ narrative: post } as unknown as ApiClient);

    const button = screen.getByRole("button", { name: "Write narrative" });
    await user.click(button);

    expect(screen.getByText("Writing narrative…")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(WINDOW);
  });

  it("renders narrative, null hypothesis, exact confidence, and evidence in API order", async () => {
    const user = userEvent.setup();
    renderPanel({
      narrative: async () =>
        narrative({
          hypothesis: null,
          confidence: 1 / 3,
          evidence: [
            { id: "fact:cycletime:first_review_p50", value: 90.5 },
            { id: "fact:rubberstamp:bea", value: null },
            { id: "fact:cycletime:first_review_p50", value: 90.5 },
          ],
        }),
    } as unknown as ApiClient);

    await user.click(screen.getByRole("button", { name: "Write narrative" }));

    expect(await screen.findByText("Reviews pile up.")).toBeTruthy();
    expect(screen.getByText("ada/scope · 100–200")).toBeTruthy();
    expect(screen.getByText("No hypothesis.")).toBeTruthy();
    expect(screen.getByText(String(1 / 3))).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "Confidence" });
    expect(meter.getAttribute("value")).toBe(String(1 / 3));
    expect(meter.getAttribute("min")).toBe("0");
    expect(meter.getAttribute("max")).toBe("1");

    const chips = within(screen.getByRole("list", { name: "Evidence" })).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "fact:cycletime:first_review_p50 · 90.5",
      "fact:rubberstamp:bea · null",
      "fact:cycletime:first_review_p50 · 90.5",
    ]);
  });

  it("links a table fact to the cell with the same id and highlights it", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <InsightTables
          client={{ insights: async () => insights() } as unknown as ApiClient}
          window={WINDOW}
        />
        <NarrativePanel
          client={{ narrative: async () => narrative() } as unknown as ApiClient}
          window={WINDOW}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Write narrative" }));
    const chip = await screen.findByRole("link", { name: "fact:leaderboard:reviewers:ada · 9" });
    expect(chip.getAttribute("href")).toBe("#fact:leaderboard:reviewers:ada");

    const cell = document.getElementById("fact:leaderboard:reviewers:ada");
    expect(cell?.textContent).toBe("9");
    await user.click(chip);
    expect(cell?.getAttribute("data-cited")).toBe("true");
  });

  it("does not link a fact the tables do not render", async () => {
    const user = userEvent.setup();
    renderPanel({
      narrative: async () =>
        narrative({
          evidence: [{ id: "fact:loadbalance:reviews_gini", value: 0.5 }],
        }),
    } as unknown as ApiClient);

    await user.click(screen.getByRole("button", { name: "Write narrative" }));
    expect(
      await screen.findByText("fact:loadbalance:reviews_gini · 0.5 · Not in the tables."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(isTableFact("fact:loadbalance:reviews_gini")).toBe(false);
    expect(isTableFact("fact:reciprocity:ada->bea")).toBe(false);
    expect(isTableFact("fact:leaderboard:reviewers:ada")).toBe(true);
  });

  it("shows the API message and keeps the previous narrative off the page", async () => {
    const user = userEvent.setup();
    renderPanel({
      narrative: async () => {
        throw new ApiError(429, "Too many narrative requests from this IP.", {
          status: 429,
          error: "Too Many Requests",
          message: "Too many narrative requests from this IP.",
        });
      },
    } as unknown as ApiClient);

    await user.click(screen.getByRole("button", { name: "Write narrative" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Too many narrative requests from this IP.",
    );
    expect(screen.queryByText("Reviews pile up.")).toBeNull();
  });

  it("clears a narrative when the window changes, including an in-flight response", async () => {
    const user = userEvent.setup();
    let resolve: (value: NarrativeResponse) => void = () => {};
    const post = vi.fn(
      () =>
        new Promise<NarrativeResponse>((res) => {
          resolve = res;
        }),
    );
    const view = renderPanel({ narrative: post } as unknown as ApiClient);

    await user.click(screen.getByRole("button", { name: "Write narrative" }));
    expect(screen.getByText("Writing narrative…")).toBeTruthy();
    view.setWindow({ ...WINDOW, repo: "other" });

    expect(screen.queryByText("Writing narrative…")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Write narrative" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    resolve(narrative());
    await vi.waitFor(() => {
      expect(screen.queryByText("Reviews pile up.")).toBeNull();
    });
  });

  it("says when the model cited nothing", async () => {
    const user = userEvent.setup();
    renderPanel({
      narrative: async () => narrative({ hypothesis: "A stall.", evidence: [] }),
    } as unknown as ApiClient);

    await user.click(screen.getByRole("button", { name: "Write narrative" }));
    expect(await screen.findByText("A stall.")).toBeTruthy();
    expect(screen.getByText("No evidence cited.")).toBeTruthy();
  });
});
