import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import { redactSecrets } from "../lib/errors.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_PAGES = 100;

export type GitHubLog = {
  warn: (message: string) => void;
};

export type GitHubClientOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  maxBackoffMs?: number;
  maxPages?: number;
  log?: GitHubLog;
};

export type GitHubClient = {
  request: <T>(route: string, parameters?: Record<string, unknown>) => Promise<T>;
  paginate: <T>(route: string, parameters?: Record<string, unknown>) => Promise<T[]>;
};

type RetryOptions = {
  token: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  maxRetries: number;
  maxBackoffMs: number;
  log: GitHubLog;
};

type RequestOptions = {
  method: string;
  url?: string;
  headers?: Record<string, unknown>;
  owner?: unknown;
  repo?: unknown;
};

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function isRateLimited(error: unknown): error is RequestError {
  if (!(error instanceof RequestError)) return false;
  if (error.status !== 403 && error.status !== 429) return false;
  if (error.status === 429) return true;

  const headers = error.response?.headers;
  if (headerValue(headers, "x-ratelimit-remaining") === "0") return true;
  if (headerValue(headers, "retry-after")) return true;
  return /secondary rate limit|rate limit exceeded/i.test(error.message);
}

function delayFor(error: RequestError, attempt: number, options: RetryOptions): number {
  const headers = error.response?.headers;
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds, 0) * 1000, options.maxBackoffMs);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - options.now(), 0), options.maxBackoffMs);
    }
  }

  const reset = headerValue(headers, "x-ratelimit-reset");
  if (headerValue(headers, "x-ratelimit-remaining") === "0" && reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      return Math.min(Math.max(resetMs - options.now(), 0), options.maxBackoffMs);
    }
  }

  return Math.min(1000 * 2 ** attempt, options.maxBackoffMs);
}

function githubError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function isNormalized(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
  );
}

function notFoundMessage(owner: unknown, repo: unknown, token: string): string {
  if (
    typeof owner === "string" &&
    owner.length > 0 &&
    typeof repo === "string" &&
    repo.length > 0
  ) {
    return redactSecrets(`Repository ${owner}/${repo} not found`, [token]);
  }
  return "GitHub resource not found";
}

function rateLimitMessage(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return `GitHub rate limit exceeded. Retry after ${seconds} seconds.`;
}

function normalizeError(
  error: unknown,
  request: RequestOptions,
  token: string,
): Error & { statusCode: number } {
  if (isNormalized(error)) return error;

  if (error instanceof RequestError) {
    if (error.status === 404) {
      return githubError(404, notFoundMessage(request.owner, request.repo, token));
    }
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = redactSecrets(error.message || "GitHub request failed", [token]);
    return githubError(status, message);
  }

  const message = error instanceof Error ? error.message : "GitHub request failed";
  return githubError(500, redactSecrets(message, [token]));
}

function retryTarget(request: RequestOptions, token: string): string {
  return redactSecrets(`${request.method} ${request.url ?? "request"}`, [token]);
}

export function createGitHubClient(
  config: Pick<Config, "githubToken">,
  options: GitHubClientOptions = {},
): GitHubClient {
  const retry: RetryOptions = {
    token: config.githubToken,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? Date.now,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    log: options.log ?? { warn: () => undefined },
  };
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const octokit = new Octokit({
    auth: config.githubToken,
    userAgent: "stethoscope",
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    request: options.fetch ? { fetch: options.fetch } : undefined,
  });

  octokit.hook.wrap("request", async (request, requestOptions) => {
    let attempt = 0;
    while (true) {
      try {
        return await request(requestOptions);
      } catch (error) {
        if (isRateLimited(error) && attempt < retry.maxRetries) {
          const delay = delayFor(error, attempt, retry);
          retry.log.warn(
            `GitHub rate limit for ${retryTarget(requestOptions, retry.token)}; retrying in ${delay}ms`,
          );
          await retry.sleep(delay);
          attempt += 1;
          continue;
        }
        if (isRateLimited(error)) {
          throw githubError(429, rateLimitMessage(delayFor(error, attempt, retry)));
        }
        throw normalizeError(error, requestOptions, retry.token);
      }
    }
  });

  return {
    async request<T>(route: string, parameters: Record<string, unknown> = {}): Promise<T> {
      const response = await octokit.request(route as "GET /user", { ...parameters });
      return response.data as T;
    },

    async paginate<T>(route: string, parameters: Record<string, unknown> = {}): Promise<T[]> {
      const iterator = octokit.paginate.iterator(
        route as "GET /user",
        {
          per_page: 100,
          ...parameters,
        } as never,
      );
      const items: T[] = [];
      let pages = 0;

      for await (const page of iterator) {
        if (!Array.isArray(page.data)) {
          throw githubError(500, "GitHub pagination expected an array response");
        }
        items.push(...(page.data as T[]));
        pages += 1;
        const link = headerValue(page.headers, "link") ?? "";
        if (!link.includes('rel="next"')) return items;
        if (pages >= maxPages) {
          throw githubError(500, "GitHub pagination exceeded the page cap");
        }
      }

      return items;
    },
  };
}
