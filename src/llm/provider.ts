import type { z } from "zod";

/**
 * Swappable completion seam. `schema` is a zod 3 schema, not a vendor JSON schema.
 * Implementations must not throw vendor error types.
 */
export interface LLMProvider {
  complete<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
}

/** Model text was missing, refused, truncated, non-JSON, or failed schema validation. */
export class LlmOutputError extends Error {
  readonly statusCode = 502;
  readonly code = "malformed_output" as const;

  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** The provider call failed before a usable completion. Status is always 502. */
export class LlmRequestError extends Error {
  readonly statusCode = 502;
  readonly code = "request_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "LlmRequestError";
  }
}
