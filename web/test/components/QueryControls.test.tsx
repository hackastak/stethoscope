import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type ApiClient,
  type InsightsResponse,
  type RepoSummary,
  type SyncResponse,
  type WindowQuery,
} from "../../src/api/client.js";
import { QueryControls } from "../../src/components/QueryControls.js";

const NOW = Date.parse("2026-09-28T15:00:00.000Z");
const WINDOW = {
  since: "2026-08-29T00:00:00Z",
  until: "2026-09-28T23:59:59Z",
};

const ADA: RepoSummary = {
  owner: "ada",
  name: "scope",
  fullName: "ada/scope",
  visibility: "public",
  defaultBranch: "main",
  pushedAt: 20,
};

const SYNCED: SyncResponse = {
  prCount: 4,
  reviewCount: 9,
  window: { since: 1, until: 2 },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderControls(client: ApiClient, onWindowChange?: (window: WindowQuery | null) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <QueryControls client={client} now={() => NOW} onWindowChange={onWindowChange} />
    </QueryClientProvider>,
  );
}

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    health: async () => ({ status: "ok" }),
    repos: async () => [ADA],
    sync: async () => SYNCED,
    insights: async () => ({}) as InsightsResponse,
    insightsGraph: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

describe("QueryControls", () => {
  it("loads the token owner's repos and syncs the selected slug, then insights", async () => {
    const user = userEvent.setup();
    const syncGate = deferred<SyncResponse>();
    const insightsGate = deferred<InsightsResponse>();
    const repos = vi.fn(async () => [ADA]);
    const sync = vi.fn(() => syncGate.promise);
    const insights = vi.fn(() => insightsGate.promise);
    renderControls(client({ repos, sync, insights }));

    await screen.findByRole("option", { name: "ada/scope" });
    expect(repos).toHaveBeenCalledWith({});

    await user.selectOptions(screen.getByRole("combobox", { name: "Your repos" }), "ada/scope");
    expect((screen.getByRole("textbox", { name: "owner/repo" }) as HTMLInputElement).value).toBe(
      "ada/scope",
    );

    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Syncing…")).toBeTruthy();
    expect(sync).toHaveBeenCalledWith({ owner: "ada", repo: "scope", ...WINDOW });
    expect(insights).not.toHaveBeenCalled();

    syncGate.resolve(SYNCED);
    expect(await screen.findByText("Loading insights…")).toBeTruthy();
    expect(insights).toHaveBeenCalledWith({ owner: "ada", repo: "scope", ...WINDOW });

    insightsGate.resolve({} as InsightsResponse);
    expect(
      await screen.findByText("Synced 4 pull requests and 9 reviews. Insights loaded."),
    ).toBeTruthy();
  });

  it("syncs a typed public repo that is not in the dropdown", async () => {
    const user = userEvent.setup();
    const sync = vi.fn(async () => SYNCED);
    const insights = vi.fn(async () => ({}) as InsightsResponse);
    renderControls(client({ repos: async () => [ADA], sync, insights }));

    await screen.findByRole("option", { name: "ada/scope" });
    await user.type(screen.getByRole("textbox", { name: "owner/repo" }), "octocat/hello-world");
    await user.click(screen.getByRole("button", { name: "Sync" }));

    expect(
      await screen.findByText("Synced 4 pull requests and 9 reviews. Insights loaded."),
    ).toBeTruthy();
    expect(sync).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", ...WINDOW });
    expect(insights).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", ...WINDOW });
  });

  it("disables Sync until the date range resolves", async () => {
    const user = userEvent.setup();
    const sync = vi.fn(async () => SYNCED);
    renderControls(client({ sync }));

    const since = screen.getByLabelText("Since") as HTMLInputElement;
    expect(since.value).toBe("2026-08-29");
    expect((screen.getByRole("button", { name: "Sync" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await user.clear(since);
    expect((screen.getByRole("button", { name: "Sync" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sync needs both a since and an until date.")).toBeTruthy();
    expect(sync).not.toHaveBeenCalled();
  });

  it("disables Sync when until is before since", () => {
    renderControls(client());
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "2026-08-01" } });

    expect((screen.getByRole("button", { name: "Sync" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Until must be on or after since.")).toBeTruthy();
  });

  it("shows the API 400 message and does not load insights", async () => {
    const user = userEvent.setup();
    const insights = vi.fn(async () => ({}) as InsightsResponse);
    renderControls(
      client({
        sync: async () => {
          throw new ApiError(400, "owner: must match ^[A-Za-z0-9_.-]+$", {
            status: 400,
            error: "Bad Request",
            message: "owner: must match ^[A-Za-z0-9_.-]+$",
          });
        },
        insights,
      }),
    );

    await user.type(screen.getByRole("textbox", { name: "owner/repo" }), "bad slug");
    await user.click(screen.getByRole("button", { name: "Sync" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "owner: must match ^[A-Za-z0-9_.-]+$",
    );
    expect(insights).not.toHaveBeenCalled();
  });

  it("still syncs a typed repo when discovery fails", async () => {
    const user = userEvent.setup();
    const sync = vi.fn(async () => SYNCED);
    renderControls(
      client({
        repos: async () => {
          throw new ApiError(401, "Unauthorized", {
            status: 401,
            error: "Unauthorized",
            message: "Unauthorized",
          });
        },
        sync,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't load your repos: Unauthorized. Enter a public owner/repo below.",
    );
    expect(screen.queryByRole("combobox")).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "owner/repo" }), "octocat/hello-world");
    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(
      await screen.findByText("Synced 4 pull requests and 9 reviews. Insights loaded."),
    ).toBeTruthy();
    expect(sync).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", ...WINDOW });
  });

  it("shows an insights failure after a successful sync", async () => {
    const user = userEvent.setup();
    renderControls(
      client({
        insights: async () => {
          throw new ApiError(409, "No synced data for octocat/hello-world between 1 and 2.", {
            status: 409,
            error: "Conflict",
            message: "No synced data for octocat/hello-world between 1 and 2.",
          });
        },
      }),
    );

    await user.type(screen.getByRole("textbox", { name: "owner/repo" }), "octocat/hello-world");
    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "No synced data for octocat/hello-world between 1 and 2.",
    );
  });

  it("clears the insight window during sync and publishes it after insights are requested", async () => {
    const user = userEvent.setup();
    const windows: Array<WindowQuery | null> = [];
    const syncGate = deferred<SyncResponse>();
    renderControls(
      client({
        sync: () => syncGate.promise,
        insights: async () => ({}) as InsightsResponse,
      }),
      (window) => {
        windows.push(window);
      },
    );

    await user.type(screen.getByRole("textbox", { name: "owner/repo" }), "ada/scope");
    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(windows).toEqual([null]);

    syncGate.resolve(SYNCED);
    expect(
      await screen.findByText("Synced 4 pull requests and 9 reviews. Insights loaded."),
    ).toBeTruthy();
    expect(windows).toEqual([null, { owner: "ada", repo: "scope", ...WINDOW }]);
  });
});
