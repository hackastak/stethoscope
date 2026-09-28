import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../src/api/client.js";

const RESPONSE = {
  window: { owner: "ada", repo: "scope", since: 1, until: 2 },
  narrative: "Reviews pile up.",
  hypothesis: null,
  confidence: 0,
  evidence: [],
};

describe("narrative client", () => {
  it("posts the window and omits bounds the caller did not set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }));
    const client = createApiClient({ fetch: fetchImpl as typeof fetch });

    await client.narrative({ owner: "ada", repo: "scope" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/narrative",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ owner: "ada", repo: "scope" }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("posts explicit bounds and surfaces the problem message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 502,
            error: "Bad Gateway",
            message: "The model cited an unknown fact.",
          }),
          { status: 502 },
        ),
    );
    const client = createApiClient({ fetch: fetchImpl as typeof fetch });

    await expect(
      client.narrative({
        owner: "ada",
        repo: "scope",
        since: "2026-08-29T00:00:00Z",
        until: "2026-09-28T23:59:59Z",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "The model cited an unknown fact.",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/narrative",
      expect.objectContaining({
        body: JSON.stringify({
          owner: "ada",
          repo: "scope",
          since: "2026-08-29T00:00:00Z",
          until: "2026-09-28T23:59:59Z",
        }),
      }),
    );
  });

  it("uses ApiError for a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const client = createApiClient({ fetch: fetchImpl as typeof fetch });

    await expect(client.narrative({ owner: "ada", repo: "scope" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
