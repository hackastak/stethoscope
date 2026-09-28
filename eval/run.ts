import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import type { EvalCase } from "./cases.js";
import { loadEvalCases } from "./cases.js";
import type { Config } from "../src/config.js";
import { createAnthropicProvider } from "../src/llm/anthropic.js";
import { createMemoryNarrativeCache, type NarrativeCache } from "../src/llm/cache.js";
import { UngroundedNarrativeError, synthesize } from "../src/llm/narrative.js";
import { LlmOutputError, LlmRequestError, type LLMProvider } from "../src/llm/provider.js";
import { narrativeOutputSchema, type NarrativeOutput } from "../src/schemas/narrative.js";

/**
 * Narrative eval. Default provider is Anthropic, called with the fixture model.
 * `STETHOSCOPE_EVAL_PROVIDER=stub` is a harness check, not a model score.
 * Decisions Q37, Q38.
 */
export type EvalAssertion =
  "shape" | "evidence-ids" | "confidence" | "required-evidence" | "hypothesis" | "provider";

export type EvalFailure = {
  assertion: EvalAssertion;
  message: string;
};

export type EvalCaseResult = {
  id: string;
  passed: boolean;
  failures: readonly EvalFailure[];
};

export type EvalReport = {
  results: readonly EvalCaseResult[];
};

export type RunEvalOptions = {
  provider?: LLMProvider;
  createProvider?: (evalCase: EvalCase) => LLMProvider;
  cache?: NarrativeCache;
};

export type EvalMainOptions = RunEvalOptions & {
  cases?: readonly EvalCase[];
  env?: NodeJS.Dict<string>;
  write?: (text: string) => void;
  exit?: (code: number) => void;
};

export function evalExitCode(report: EvalReport): number {
  if (report.results.length === 0) return 1;
  return report.results.some((result) => !result.passed) ? 1 : 0;
}

export function formatEvalReport(report: EvalReport): string {
  const chunks: string[] = [];
  if (report.results.length === 0) {
    chunks.push("FAIL (run)\n  cases: no fixtures loaded");
  }
  for (const result of report.results) {
    const lines = [`${result.passed ? "PASS" : "FAIL"} ${result.id}`];
    for (const failure of result.failures) {
      lines.push(`  ${failure.assertion}: ${failure.message}`);
    }
    chunks.push(lines.join("\n"));
  }
  const passed = report.results.filter((result) => result.passed).length;
  const failed = report.results.length - passed;
  return `${chunks.join("\n")}\n\n${passed} passed, ${failed} failed, ${report.results.length} total\n`;
}

export async function runEval(
  cases: readonly EvalCase[],
  options: RunEvalOptions,
): Promise<EvalReport> {
  const cache = options.cache ?? createMemoryNarrativeCache();
  const results: EvalCaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(evalCase, providerFor(evalCase, options), cache));
  }
  return { results };
}

export async function main(options: EvalMainOptions = {}): Promise<number> {
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });
  try {
    const report = await reportFor(options);
    const code = evalExitCode(report);
    write(formatEvalReport(report));
    exit(code);
    return code;
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : "eval failed";
    write(`FAIL (run)\n  provider: ${message}\n`);
    exit(1);
    return 1;
  }
}

function providerFor(evalCase: EvalCase, options: RunEvalOptions): LLMProvider {
  if (options.provider && options.createProvider) {
    throw new Error("pass provider or createProvider, not both");
  }
  const provider = options.createProvider?.(evalCase) ?? options.provider;
  if (!provider) throw new Error("eval requires a provider");
  return provider;
}

async function runCase(
  evalCase: EvalCase,
  provider: LLMProvider,
  cache: NarrativeCache,
): Promise<EvalCaseResult> {
  try {
    const output = await synthesize(evalCase.facts, {
      provider,
      cache,
      owner: evalCase.context.owner,
      repo: evalCase.context.repo,
      since: evalCase.context.since,
      until: evalCase.context.until,
      model: evalCase.context.model,
      promptVersion: evalCase.promptVersion,
    });
    const failures = assertNarrative(evalCase, output);
    return { id: evalCase.id, passed: failures.length === 0, failures };
  } catch (error) {
    return { id: evalCase.id, passed: false, failures: [failureFromError(error)] };
  }
}

function assertNarrative(evalCase: EvalCase, output: NarrativeOutput): readonly EvalFailure[] {
  const parsed = narrativeOutputSchema.safeParse(output);
  if (!parsed.success) {
    return [{ assertion: "shape", message: "Narrative completion failed schema validation" }];
  }
  const narrative = parsed.data;
  const known = new Set(evalCase.facts.map((fact) => fact.id));
  const unknown = [...new Set(narrative.evidence.filter((id) => !known.has(id)))].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  let failures: readonly EvalFailure[] = [];
  if (unknown.length > 0) {
    failures = [
      ...failures,
      { assertion: "evidence-ids", message: `cited unknown fact ids: ${unknown.join(", ")}` },
    ];
  }
  const { min, max } = evalCase.expect.confidence;
  if (narrative.confidence < min || narrative.confidence > max) {
    failures = [
      ...failures,
      { assertion: "confidence", message: `${narrative.confidence} is outside ${min}-${max}` },
    ];
  }
  const cited = new Set(narrative.evidence);
  const missing = evalCase.expect.requiredEvidence.filter((id) => !cited.has(id));
  if (missing.length > 0) {
    failures = [
      ...failures,
      { assertion: "required-evidence", message: `missing ${missing.join(", ")}` },
    ];
  }
  if (evalCase.expect.hypothesis === "required" && narrative.hypothesis === null) {
    failures = [
      ...failures,
      { assertion: "hypothesis", message: "expected a non-null hypothesis" },
    ];
  }
  if (evalCase.expect.hypothesis === "null" && narrative.hypothesis !== null) {
    failures = [...failures, { assertion: "hypothesis", message: "expected null" }];
  }
  return failures;
}

function failureFromError(error: unknown): EvalFailure {
  if (error instanceof UngroundedNarrativeError) {
    return {
      assertion: "evidence-ids",
      message: `cited unknown fact ids: ${error.unknownIds.join(", ")}`,
    };
  }
  if (error instanceof LlmOutputError) {
    return { assertion: "shape", message: error.message };
  }
  if (error instanceof LlmRequestError) {
    return { assertion: "provider", message: error.message };
  }
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : "eval case failed";
  return { assertion: "provider", message };
}

function createPassingStubProvider(evalCase: EvalCase): LLMProvider {
  const output: NarrativeOutput = {
    narrative: `Stub narrative for ${evalCase.id}.`,
    hypothesis:
      evalCase.expect.hypothesis === "required" ? "The cited facts support a cause." : null,
    confidence: (evalCase.expect.confidence.min + evalCase.expect.confidence.max) / 2,
    evidence: [...evalCase.expect.requiredEvidence],
  };
  return {
    async complete(_prompt, schema) {
      const parsed = schema.safeParse(output);
      if (!parsed.success) {
        throw new LlmOutputError("Narrative completion failed schema validation");
      }
      return parsed.data;
    },
  };
}

async function reportFor(options: EvalMainOptions): Promise<EvalReport> {
  const cases = options.cases ?? loadEvalCases();
  if (options.provider || options.createProvider) {
    return runEval(cases, options);
  }
  const env = options.env ?? loadedEnv();
  if (providerMode(env) === "stub") {
    return runEval(cases, { createProvider: createPassingStubProvider, cache: options.cache });
  }
  const apiKey = anthropicKey(env);
  return runEval(cases, {
    cache: options.cache,
    createProvider: (evalCase) =>
      createAnthropicProvider(providerConfig(apiKey, evalCase.context.model)),
  });
}

function loadedEnv(): NodeJS.Dict<string> {
  loadDotenv({ quiet: true });
  return process.env;
}

function providerMode(env: NodeJS.Dict<string>): "stub" | "anthropic" {
  const raw = env.STETHOSCOPE_EVAL_PROVIDER;
  if (raw === undefined || raw === "" || raw === "anthropic") return "anthropic";
  if (raw === "stub") return "stub";
  throw new Error(`Invalid STETHOSCOPE_EVAL_PROVIDER: ${raw}. Expected stub or anthropic.`);
}

function anthropicKey(env: NodeJS.Dict<string>): string {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  return key;
}

function providerConfig(apiKey: string, model: string): Config {
  return Object.freeze({
    githubToken: "eval-does-not-call-github",
    anthropicApiKey: apiKey,
    llmModel: model,
    port: 3000,
    databasePath: ":memory:",
    fastApprovalSeconds: 300,
    minPrSize: 100,
    minReciprocityInteractions: 3,
  });
}

function isDirectRun(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return import.meta.url === pathToFileURL(argvPath).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : "eval failed";
    process.stdout.write(`FAIL (run)\n  provider: ${message}\n`);
    process.exit(1);
  });
}
