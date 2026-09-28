import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evalCases } from "../../eval/cases.js";
import { evalExitCode, formatEvalReport, main, runEval, type EvalReport } from "../../eval/run.js";
import {
  createMemoryNarrativeCache,
  type NarrativeCache,
  type NarrativeCacheKey,
} from "../../src/llm/cache.js";
import { LlmOutputError, LlmRequestError, type LLMProvider } from "../../src/llm/provider.js";
import type { NarrativeOutput } from "../../src/schemas/narrative.js";

function caseById(id: string) {
  const found = evalCases.find((evalCase) => evalCase.id === id);
  if (!found) throw new Error(`missing case ${id}`);
  return found;
}

function completion(
  overrides: Partial<NarrativeOutput> &
    Pick<NarrativeOutput, "evidence" | "confidence" | "hypothesis">,
): NarrativeOutput {
  return {
    narrative: "Ada's approvals are fast relative to the review size.",
    ...overrides,
  };
}

function provider(output: NarrativeOutput | Error): LLMProvider & { calls: number } {
  return {
    calls: 0,
    async complete(_prompt, schema) {
      this.calls += 1;
      if (output instanceof Error) throw output;
      const parsed = schema.safeParse(output);
      if (!parsed.success)
        throw new LlmOutputError("Narrative completion failed schema validation");
      return parsed.data;
    },
  };
}

function recordingCache(): NarrativeCache & { keys: NarrativeCacheKey[] } {
  const inner = createMemoryNarrativeCache();
  const keys: NarrativeCacheKey[] = [];
  return {
    keys,
    get(key) {
      return inner.get(key);
    },
    set(key, value) {
      keys.push(key);
      inner.set(key, value);
    },
  };
}

const rubber = caseById("rubber-stamp");
const noisy = caseById("noisy-sample");
const balanced = caseById("balanced-team");
const empty = caseById("insufficient-data");

const rubberPass = completion({
  hypothesis: "Ada is approving without reading.",
  confidence: 0.7,
  evidence: ["fact:rubberstamp:ada", "fact:rubberstamp:ada->grace"],
});

describe("eval runner", () => {
  it("passes a grounded completion on the confidence boundary and ignores extra real ids", async () => {
    const report = await runEval([rubber], {
      provider: provider(
        completion({
          hypothesis: "not graded",
          confidence: 1,
          evidence: [
            "fact:rubberstamp:ada",
            "fact:rubberstamp:ada",
            "fact:rubberstamp:ada->grace",
            "fact:rubberstamp:grace",
          ],
        }),
      ),
    });

    expect(report.results).toEqual([{ id: "rubber-stamp", passed: true, failures: [] }]);
    expect(evalExitCode(report)).toBe(0);
  });

  it("passes an empty citation list only when the fixture requires none", async () => {
    const report = await runEval([empty], {
      provider: provider(completion({ hypothesis: null, confidence: 0, evidence: [] })),
    });

    expect(report.results[0]).toEqual({ id: "insufficient-data", passed: true, failures: [] });
  });

  it("names every failed assertion and still runs the next case", async () => {
    const report = await runEval([noisy, rubber], {
      createProvider: (evalCase) =>
        evalCase.id === "noisy-sample"
          ? provider(
              completion({
                hypothesis: "A thin sample is not a cause.",
                confidence: 0.9,
                evidence: ["fact:cycletime:approval_to_merge_n"],
              }),
            )
          : provider(rubberPass),
    });

    expect(formatEvalReport(report)).toBe(
      [
        "FAIL noisy-sample",
        "  confidence: 0.9 is outside 0-0.4",
        "  required-evidence: missing fact:rubberstamp:ada, fact:reciprocity:ada->grace, fact:cycletime:first_review_n",
        "  hypothesis: expected null",
        "PASS rubber-stamp",
        "",
        "1 passed, 1 failed, 2 total",
        "",
      ].join("\n"),
    );
    expect(evalExitCode(report)).toBe(1);
  });

  it("names a null hypothesis when the fixture requires one", async () => {
    const report = await runEval([rubber], {
      provider: provider(completion({ ...rubberPass, hypothesis: null })),
    });

    expect(report.results[0]?.failures).toEqual([
      { assertion: "hypothesis", message: "expected a non-null hypothesis" },
    ]);
  });

  it("names unknown evidence ids after the narrative service rejects them", async () => {
    const report = await runEval([balanced], {
      provider: provider(
        completion({
          hypothesis: null,
          confidence: 0.8,
          evidence: ["fact:not-a-fact:ada", "fact:reciprocity:ada"],
        }),
      ),
    });

    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.failures).toEqual([
      { assertion: "evidence-ids", message: "cited unknown fact ids: fact:not-a-fact:ada" },
    ]);
  });

  it("names a schema failure as shape and a request failure as provider", async () => {
    const malformed = await runEval([rubber], {
      provider: {
        async complete() {
          return { narrative: "", hypothesis: null, confidence: 0, evidence: [] };
        },
      },
    });
    const requested = await runEval([rubber], {
      provider: provider(new LlmRequestError("LLM request failed (401): unauthorized")),
    });

    expect(malformed.results[0]?.failures).toEqual([
      { assertion: "shape", message: "Narrative completion failed schema validation" },
    ]);
    expect(requested.results[0]?.failures).toEqual([
      { assertion: "provider", message: "LLM request failed (401): unauthorized" },
    ]);
  });

  it("sends the fixture context and prompt version through synthesize", async () => {
    const cache = recordingCache();
    await runEval([rubber], { provider: provider(rubberPass), cache });

    expect(cache.keys).toEqual([
      expect.objectContaining({
        owner: rubber.context.owner,
        repo: rubber.context.repo,
        since: rubber.context.since,
        until: rubber.context.until,
        model: rubber.context.model,
        promptVersion: rubber.promptVersion,
      }),
    ]);
  });

  it("exits non-zero when no fixtures are loaded", () => {
    const report: EvalReport = { results: [] };
    expect(evalExitCode(report)).toBe(1);
    expect(formatEvalReport(report)).toBe(
      "FAIL (run)\n  cases: no fixtures loaded\n\n0 passed, 0 failed, 0 total\n",
    );
  });
});

describe("eval cli", () => {
  it("exits 1 when a case fails and names the assertion", async () => {
    const lines: string[] = [];
    let code = 0;
    const returned = await main({
      cases: [noisy],
      provider: provider(completion({ hypothesis: null, confidence: 0.9, evidence: [] })),
      write: (text) => {
        lines.push(text);
      },
      exit: (next) => {
        code = next;
      },
    });

    expect(returned).toBe(1);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("FAIL noisy-sample");
    expect(lines.join("")).toContain("confidence: 0.9 is outside 0-0.4");
  });

  it("exits 1 before running cases when the provider mode is unknown", async () => {
    const lines: string[] = [];
    let code = 0;
    const returned = await main({
      env: { STETHOSCOPE_EVAL_PROVIDER: "live" },
      cases: [rubber],
      write: (text) => {
        lines.push(text);
      },
      exit: (next) => {
        code = next;
      },
    });

    expect(returned).toBe(1);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("provider: Invalid STETHOSCOPE_EVAL_PROVIDER: live");
    expect(lines.join("")).not.toContain("PASS");
  });

  it("exits 0 against the stub provider and does not require an API key", async () => {
    const lines: string[] = [];
    let code = 1;
    await main({
      env: { STETHOSCOPE_EVAL_PROVIDER: "stub" },
      write: (text) => {
        lines.push(text);
      },
      exit: (next) => {
        code = next;
      },
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("6 passed, 0 failed, 6 total");
    expect(lines.join("")).not.toContain("ANTHROPIC_API_KEY");
  });

  it("the script process exits 1 when the provider mode is unknown", async () => {
    const result = await runCli({ STETHOSCOPE_EVAL_PROVIDER: "nope" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("provider: Invalid STETHOSCOPE_EVAL_PROVIDER: nope");
  });

  it("the npm entry exits 0 against the stub provider", async () => {
    const result = await runCli({ STETHOSCOPE_EVAL_PROVIDER: "stub" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS rubber-stamp");
    expect(result.stdout).toContain("6 passed, 0 failed, 6 total");
  }, 30_000);
});

function runCli(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "node_modules/.bin/tsx",
      ["eval/run.ts"],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "", ...env },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}
