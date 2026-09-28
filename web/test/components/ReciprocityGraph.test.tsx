import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient, type InsightsGraphResponse } from "../../src/api/client.js";
import {
  FLAGGED_EDGE_COLOR,
  MUTUAL_EDGE_COLOR,
  ReciprocityGraph,
  edgeDash,
  edgeWidth,
  escapeTooltip,
  hoverText,
  nodeArea,
} from "../../src/components/ReciprocityGraph.js";

const WINDOW = {
  owner: "ada",
  repo: "scope",
  since: "2026-08-29T00:00:00Z",
  until: "2026-09-28T23:59:59Z",
};

type GraphProps = {
  graphData: {
    nodes: Array<{ id: string; label: string; reviewsGiven: number; reviewsReceived: number }>;
    links: Array<{ source: string; target: string; weight: number; flagged: boolean }>;
  };
  nodeVal: (node: { reviewsGiven: number; reviewsReceived: number }) => number;
  nodeLabel: (node: { label: string; reviewsGiven: number; reviewsReceived: number }) => string;
  linkColor: (link: { flagged?: boolean }) => string;
  linkWidth: (link: { flagged?: boolean }) => number;
  linkLineDash: (link: { flagged?: boolean }) => number[] | null;
  onNodeHover?: (
    node: { id: string; label: string; reviewsGiven: number; reviewsReceived: number } | null,
  ) => void;
};

vi.mock("react-force-graph-2d", () => ({
  default: function MockForceGraph(props: GraphProps) {
    return (
      <div data-testid="force-graph">
        {props.graphData.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            data-node={node.id}
            data-size={props.nodeVal(node)}
            data-tooltip={props.nodeLabel(node)}
            onMouseEnter={() => props.onNodeHover?.(node)}
            onMouseLeave={() => props.onNodeHover?.(null)}
          >
            {node.label}
          </button>
        ))}
        {props.graphData.links.map((link) => (
          <span
            key={`${link.source}->${link.target}`}
            data-edge={`${link.source}->${link.target}`}
            data-flagged={link.flagged ? "true" : "false"}
            data-color={props.linkColor(link)}
            data-width={props.linkWidth(link)}
            data-dash={props.linkLineDash(link)?.join(",") ?? ""}
          />
        ))}
      </div>
    );
  },
}));

function graph(overrides: Partial<InsightsGraphResponse> = {}): InsightsGraphResponse {
  return {
    nodes: [
      { id: "ada", label: "ada", reviewsGiven: 4, reviewsReceived: 1 },
      { id: "bea", label: "bea<script>", reviewsGiven: 0, reviewsReceived: 4 },
    ],
    edges: [
      { source: "ada", target: "bea", weight: 4, flagged: true },
      { source: "cy", target: "ada", weight: 1, flagged: false },
    ],
    ...overrides,
  };
}

function renderGraph(client: ApiClient, query: typeof WINDOW | null = WINDOW) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReciprocityGraph client={client} window={query} />
    </QueryClientProvider>,
  );
}

describe("ReciprocityGraph", () => {
  it("keeps a zero-volume node visible", () => {
    expect(nodeArea({ reviewsGiven: 0, reviewsReceived: 0 })).toBe(1);
  });

  it("asks for a sync before any window exists", () => {
    renderGraph({ insightsGraph: vi.fn() } as unknown as ApiClient, null);
    expect(screen.getByText("Sync a repository to load the reciprocity graph.")).toBeTruthy();
    expect(screen.queryByTestId("force-graph")).toBeNull();
  });

  it("shows a loading state until the graph payload arrives", () => {
    renderGraph({ insightsGraph: () => new Promise(() => {}) } as unknown as ApiClient);
    expect(screen.getByText("Loading reciprocity graph…")).toBeTruthy();
    expect(screen.queryByTestId("force-graph")).toBeNull();
  });

  it("renders nodes and edges, with flagged edges styled apart from mutual ones", async () => {
    const insightsGraph = vi.fn(async () => graph());
    renderGraph({ insightsGraph } as unknown as ApiClient);

    expect(await screen.findByTestId("force-graph")).toBeTruthy();
    expect(insightsGraph).toHaveBeenCalledWith(WINDOW);

    const ada = screen.getByRole("button", { name: "ada" });
    const bea = screen.getByRole("button", { name: "bea<script>" });
    expect(ada.getAttribute("data-size")).toBe(
      String(nodeArea({ reviewsGiven: 4, reviewsReceived: 1 })),
    );
    expect(bea.getAttribute("data-size")).toBe(
      String(nodeArea({ reviewsGiven: 0, reviewsReceived: 4 })),
    );
    expect(ada.getAttribute("data-tooltip")).toBe(
      escapeTooltip(
        hoverText({
          label: "ada",
          reviewsGiven: 4,
          reviewsReceived: 1,
        }),
      ),
    );
    expect(bea.getAttribute("data-tooltip")).toBe("bea&lt;script&gt;: given 0, received 4");

    const flagged = document.querySelector("[data-edge='ada->bea']");
    const mutual = document.querySelector("[data-edge='cy->ada']");
    expect(flagged?.getAttribute("data-color")).toBe(FLAGGED_EDGE_COLOR);
    expect(mutual?.getAttribute("data-color")).toBe(MUTUAL_EDGE_COLOR);
    expect(flagged?.getAttribute("data-color")).not.toBe(mutual?.getAttribute("data-color"));
    expect(flagged?.getAttribute("data-width")).toBe(String(edgeWidth({ flagged: true })));
    expect(mutual?.getAttribute("data-width")).toBe(String(edgeWidth({ flagged: false })));
    expect(flagged?.getAttribute("data-dash")).toBe(edgeDash({ flagged: true })?.join(","));
    expect(mutual?.getAttribute("data-dash")).toBe("");

    const list = screen.getByRole("list", { name: "Reciprocity edges" });
    expect(list.textContent).toContain("ada → bea · weight 4 · one-directional");
    expect(list.textContent).toContain("cy → ada · weight 1");
    expect(list.querySelector("[data-flagged='true']")?.textContent).toContain("ada → bea");
  });

  it("shows given and received when a node is hovered", async () => {
    const user = userEvent.setup();
    renderGraph({ insightsGraph: async () => graph() } as unknown as ApiClient);

    await user.hover(await screen.findByRole("button", { name: "ada" }));
    expect(screen.getByRole("status").textContent).toBe("ada: given 4, received 1");

    await user.unhover(screen.getByRole("button", { name: "ada" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Hover a person to see reviews given and received.",
    );
  });

  it("says when the window has no edges", async () => {
    renderGraph({
      insightsGraph: async () => graph({ nodes: [], edges: [] }),
    } as unknown as ApiClient);
    expect(await screen.findByText("No reciprocity edges in this window.")).toBeTruthy();
    expect(screen.queryByTestId("force-graph")).toBeNull();
  });

  it("shows the API message when the graph fails", async () => {
    renderGraph({
      insightsGraph: async () => {
        throw new ApiError(409, "No synced data for ada/scope between 1 and 2.", {
          status: 409,
          error: "Conflict",
          message: "No synced data for ada/scope between 1 and 2.",
        });
      },
    } as unknown as ApiClient);
    expect(await screen.findByText("No synced data for ada/scope between 1 and 2.")).toBeTruthy();
  });
});
