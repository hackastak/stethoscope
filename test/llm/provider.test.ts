import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../../src/config.js";
import { createAnthropicProvider } from "../../src/llm/index.js";
import { LlmOutputError, LlmRequestError } from "../../src/llm/provider.js";

const KEY = "sk-ant-config-key";
const ENV_KEY = "sk-ant-env-key-should-not-be-used";
const MODEL = "claude-sonnet-5";

const answerSchema = z.object({
  narrative: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});

function config(): Config {
  return loadConfig({
    GITHUB_TOKEN: "ghp_test",
    ANTHROPIC_API_KEY: KEY,
    LLM_MODEL: MODEL,
  });
}

function message(text: string, stopReason = "end_turn"): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 3, output_tokens: 5 },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createAnthropicProvider", () => {
  const consoleSpies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  };
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousLog = process.env.ANTHROPIC_LOG;

  afterEach(() => {
    vi.clearAllMocks();
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousLog === undefined) delete process.env.ANTHROPIC_LOG;
    else process.env.ANTHROPIC_LOG = previousLog;
  });

  it("returns schema-validated JSON and sends the config key, not the env key", async () => {
    process.env.ANTHROPIC_API_KEY = ENV_KEY;
    process.env.ANTHROPIC_LOG = "debug";
    let apiKey = "";
    let body: Record<string, unknown> = {};
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      apiKey = new Headers(init?.headers).get("x-api-key") ?? "";
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(
        200,
        message(JSON.stringify({ narrative: "ok", confidence: 0.5, evidence: ["fact:a"] })),
      );
    });

    const provider = createAnthropicProvider(config(), { fetch });
    const result = await provider.complete("summarize these facts", answerSchema);

    expect(result).toEqual({ narrative: "ok", confidence: 0.5, evidence: ["fact:a"] });
    expect(apiKey).toBe(KEY);
    expect(apiKey).not.toBe(ENV_KEY);
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: "user", content: "summarize these facts" }]);
    expect(body.system).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain(ENV_KEY);
    const format = (
      body.output_config as { format: { type: string; schema: Record<string, unknown> } }
    ).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema.additionalProperties).toBe(false);
    expect(format.schema.required).toEqual(["narrative", "confidence", "evidence"]);
    expect(JSON.stringify(format.schema)).not.toContain("minimum");
    for (const spy of Object.values(consoleSpies)) {
      const dumped = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(dumped).not.toContain(KEY);
      expect(dumped).not.toContain(ENV_KEY);
    }
  });

  it("rejects non-JSON model output with LlmOutputError and does not echo the key", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, message(`not json ${KEY}`)));
    const provider = createAnthropicProvider(config(), { fetch });

    const error = await provider.complete("summarize", answerSchema).then(
      () => {
        throw new Error("expected malformed output");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LlmOutputError);
    expect(error).toMatchObject({ statusCode: 502, code: "malformed_output" });
    expect(error instanceof Error ? error.message : "").not.toContain(KEY);
  });

  it("rejects JSON that does not match the schema", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, message(JSON.stringify({ narrative: "ok", confidence: 2, evidence: [] }))),
    );
    const provider = createAnthropicProvider(config(), { fetch });

    await expect(provider.complete("summarize", answerSchema)).rejects.toBeInstanceOf(
      LlmOutputError,
    );
  });

  it("rejects a refusal even when the text happens to be JSON", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        200,
        message(JSON.stringify({ narrative: "no", confidence: 0, evidence: [] }), "refusal"),
      ),
    );
    const provider = createAnthropicProvider(config(), { fetch });

    await expect(provider.complete("summarize", answerSchema)).rejects.toMatchObject({
      name: "LlmOutputError",
      code: "malformed_output",
    });
  });

  it("wraps an API failure so the SDK error and key never escape", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: `bad key ${KEY}` },
      }),
    );
    const provider = createAnthropicProvider(config(), { fetch });

    const error = await provider.complete("summarize", answerSchema).then(
      () => {
        throw new Error("expected request failure");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).not.toBeInstanceOf(LlmOutputError);
    expect(error).toMatchObject({ statusCode: 502, code: "request_failed" });
    expect(error instanceof Error ? error.message : "").not.toContain(KEY);
    expect(error instanceof Error ? error.constructor.name : "").not.toMatch(
      /APIError|AuthenticationError/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a truncated completion instead of returning partial JSON", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        200,
        message(JSON.stringify({ narrative: "cut", confidence: 1, evidence: [] }), "max_tokens"),
      ),
    );
    const provider = createAnthropicProvider(config(), { fetch });

    await expect(provider.complete("summarize", answerSchema)).rejects.toMatchObject({
      name: "LlmOutputError",
      message: "LLM output was truncated",
    });
  });
});
