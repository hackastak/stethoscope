import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredEnv = {
  GITHUB_TOKEN: "ghp_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

describe("loadConfig", () => {
  it("throws a readable ConfigError when GITHUB_TOKEN is missing", () => {
    expect(() =>
      loadConfig({
        ANTHROPIC_API_KEY: "sk-ant-test",
      }),
    ).toThrow(ConfigError);

    try {
      loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/GITHUB_TOKEN/i);
      expect((error as ConfigError).message).not.toMatch(/ZodError|at Object|node_modules/i);
    }
  });

  it("throws a readable ConfigError when ANTHROPIC_API_KEY is missing", () => {
    try {
      loadConfig({ GITHUB_TOKEN: "ghp_test" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/ANTHROPIC_API_KEY/i);
      expect((error as ConfigError).message).not.toMatch(/ZodError|at Object|node_modules/i);
    }
  });

  it("returns a frozen config with documented defaults", () => {
    const config = loadConfig(requiredEnv);

    expect(Object.isFrozen(config)).toBe(true);
    expect(config).toEqual({
      githubToken: "ghp_test",
      anthropicApiKey: "sk-ant-test",
      llmModel: "claude-sonnet-5",
      port: 3000,
      databasePath: "./stethoscope.sqlite",
      fastApprovalSeconds: 300,
      minPrSize: 100,
      minReciprocityInteractions: 3,
    });
  });

  it("parses numeric env overrides", () => {
    const config = loadConfig({
      ...requiredEnv,
      LLM_MODEL: "claude-opus-4",
      PORT: "8080",
      DATABASE_PATH: "/tmp/stethoscope.sqlite",
      FAST_APPROVAL_SECONDS: "120",
      MIN_PR_SIZE: "50",
      MIN_RECIPROCITY_INTERACTIONS: "5",
    });

    expect(config.llmModel).toBe("claude-opus-4");
    expect(config.port).toBe(8080);
    expect(config.databasePath).toBe("/tmp/stethoscope.sqlite");
    expect(config.fastApprovalSeconds).toBe(120);
    expect(config.minPrSize).toBe(50);
    expect(config.minReciprocityInteractions).toBe(5);
  });

  it("throws a readable ConfigError for an invalid PORT", () => {
    try {
      loadConfig({ ...requiredEnv, PORT: "not-a-port" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/PORT/i);
      expect((error as ConfigError).message).not.toMatch(/Missing required/i);
      expect((error as ConfigError).message).not.toMatch(/ZodError|at Object|node_modules/i);
    }
  });

  it("treats an empty GITHUB_TOKEN as missing", () => {
    try {
      loadConfig({ ...requiredEnv, GITHUB_TOKEN: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/Missing required environment variable: GITHUB_TOKEN/i);
    }
  });
});

describe("boot", () => {
  it("exits with a clear message when GITHUB_TOKEN is missing", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", GITHUB_TOKEN: "" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/GITHUB_TOKEN/i);
    expect(result.stderr).not.toMatch(/ZodError|at Object|node_modules/i);
  });
});

