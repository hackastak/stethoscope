import type { Problem } from "../../../src/lib/errors.js";
import type { InsightsGraphResponse, InsightsResponse } from "../../../src/schemas/insights.js";
import type { NarrativeResponse } from "../../../src/schemas/narrative.js";

export type { InsightsGraphResponse, InsightsResponse, NarrativeResponse };

/** Mirrors `RepoSummary` in `src/github/repos.ts`. No response schema exists yet. */
export type RepoVisibility = "public" | "private" | "internal";

export type RepoSummary = {
  owner: string;
  name: string;
  fullName: string;
  visibility: RepoVisibility;
  defaultBranch: string;
  /** Unix epoch seconds. Null when GitHub has no push timestamp. */
  pushedAt: number | null;
};

/** What `POST /sync` accepts before the route transforms dates to epoch seconds. */
export type SyncRequest = {
  owner: string;
  repo: string;
  since: number | string;
  until: number | string;
};

/** The subset `POST /sync` returns. `commentCount` stays off the wire. */
export type SyncResponse = {
  prCount: number;
  reviewCount: number;
  window: {
    since: number;
    until: number;
  };
};

export type HealthResponse = {
  status: "ok";
};

/** Query for `/insights` and `/insights/graph`. Omitted bounds use the API default window. */
export type WindowQuery = {
  owner: string;
  repo: string;
  since?: number | string;
  until?: number | string;
};

export type ApiClientOptions = {
  fetch?: typeof fetch;
  /** Empty string means same-origin. The dev proxy makes that the API. */
  baseUrl?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, message: string, problem: Problem) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export type ApiClient = {
  health: () => Promise<HealthResponse>;
  repos: (query?: { owner?: string }) => Promise<RepoSummary[]>;
  sync: (body: SyncRequest) => Promise<SyncResponse>;
  insights: (query: WindowQuery) => Promise<InsightsResponse>;
  insightsGraph: (query: WindowQuery) => Promise<InsightsGraphResponse>;
  /** POST. Omitted bounds use the API default window. Does not run unless called. */
  narrative: (query: WindowQuery) => Promise<NarrativeResponse>;
};

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "number" &&
    typeof record.error === "string" &&
    typeof record.message === "string"
  );
}

function problemFrom(status: number, body: unknown, fallback: string): Problem {
  if (isProblem(body)) return body;
  return { status, error: "Error", message: fallback };
}

function toApiError(status: number, body: unknown, fallback: string): ApiError {
  const problem = problemFrom(status, body, fallback);
  return new ApiError(status, problem.message, problem);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    throw new ApiError(0, message, { status: 0, error: "Network Error", message });
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw toApiError(response.status, body, response.statusText || "Request failed");
  }
  if (body === null) {
    throw toApiError(response.status, null, "Empty response");
  }
  return body as T;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = stripTrailingSlash(options.baseUrl ?? "");

  return {
    health: () => request<HealthResponse>(fetchImpl, baseUrl, "/health"),
    repos: (query = {}) =>
      request<RepoSummary[]>(fetchImpl, baseUrl, `/repos${queryString({ owner: query.owner })}`),
    sync: (body) =>
      request<SyncResponse>(fetchImpl, baseUrl, "/sync", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    insights: (query) =>
      request<InsightsResponse>(fetchImpl, baseUrl, `/insights${queryString(query)}`),
    insightsGraph: (query) =>
      request<InsightsGraphResponse>(fetchImpl, baseUrl, `/insights/graph${queryString(query)}`),
    narrative: (query) =>
      request<NarrativeResponse>(fetchImpl, baseUrl, "/narrative", {
        method: "POST",
        body: JSON.stringify(query),
      }),
  };
}

/** Same-origin client. In dev, Vite proxies these paths to the API. */
export const api = createApiClient();
