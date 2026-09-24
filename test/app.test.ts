import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createLogger } from "../src/lib/logger.js";

const testConfig: Config = Object.freeze({
  githubToken: "ghp_test_token_aaa",
  anthropicApiKey: "sk-ant-test_key_bbb",
  llmModel: "claude-sonnet-5",
  port: 3000,
  databasePath: "./stethoscope.sqlite",
  fastApprovalSeconds: 300,
  minPrSize: 100,
  minReciprocityInteractions: 3,
});

describe("buildApp", () => {
  it("GET /health returns 200 { status: ok }", async () => {
    const app = await buildApp({ config: testConfig, logger: false });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("unhandled routes return 404 JSON", async () => {
    const app = await buildApp({ config: testConfig, logger: false });

    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(/json/);
    expect(response.json()).toEqual({
      status: 404,
      error: "Not Found",
      message: "Route GET /nope not found",
    });

    await app.close();
  });

  it("thrown errors return 500 JSON without stack or secrets in production", async () => {
    const app = await buildApp({ config: testConfig, logger: false, production: true });
    app.get("/__boom", async () => {
      throw new Error(`boom ${testConfig.githubToken} ${testConfig.anthropicApiKey}`);
    });

    const response = await app.inject({ method: "GET", url: "/__boom" });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toMatch(/json/);
    expect(body).toEqual({
      status: 500,
      error: "Internal Server Error",
      message: "boom [REDACTED] [REDACTED]",
    });
    expect(JSON.stringify(body)).not.toMatch(/stack|githubToken|ghp_test_token_aaa|sk-ant-test_key_bbb/i);

    await app.close();
  });

  it("redacts GitHub and LLM tokens from logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger(testConfig, stream);

    logger.info(
      {
        githubToken: testConfig.githubToken,
        nested: { anthropicApiKey: testConfig.anthropicApiKey },
      },
      `using ${testConfig.githubToken}`,
    );
    logger.error(new Error(`failed with ${testConfig.anthropicApiKey}`));

    const output = chunks.join("");
    expect(output).not.toContain(testConfig.githubToken);
    expect(output).not.toContain(testConfig.anthropicApiKey);
    expect(output).toContain("[REDACTED]");
  });
});
