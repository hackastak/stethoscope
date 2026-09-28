import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";

describe("insights query bounds", () => {
  it("omits since and until when the caller does not set them", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = createApiClient({ fetch: fetchImpl as typeof fetch });

    await client.insights({ owner: "ada", repo: "scope" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/insights?owner=ada&repo=scope",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});
