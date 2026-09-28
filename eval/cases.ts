import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FACT_KINDS, FACT_UNITS, type Fact } from "../src/facts/types.js";
import { NARRATIVE_PROMPT_VERSION } from "../src/llm/prompt.js";

const GITHUB_SLUG = /^[A-Za-z0-9_.-]+$/;

const factSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(FACT_KINDS),
    subject: z.string().min(1),
    value: z.number().nullable(),
    unit: z.enum(FACT_UNITS),
    detail: z.string().min(1),
  })
  .strict()
  .superRefine((fact, ctx) => {
    const expected = `fact:${fact.kind}:${fact.subject}`;
    if (fact.id !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: `must be ${expected}`,
      });
    }
  });

const expectationSchema = z
  .object({
    confidence: z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
      })
      .strict(),
    requiredEvidence: z.array(z.string().min(1)),
    hypothesis: z.enum(["required", "null"]),
  })
  .strict()
  .superRefine((expectation, ctx) => {
    if (expectation.confidence.min > expectation.confidence.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence", "min"],
        message: "must be <= confidence.max",
      });
    }
    const seen = new Set<string>();
    for (const [index, id] of expectation.requiredEvidence.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredEvidence", index],
          message: `duplicate required id ${id}`,
        });
      }
      seen.add(id);
    }
  });

const fixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    signal: z.enum(["clear", "insufficient"]),
    context: z
      .object({
        owner: z.string().regex(GITHUB_SLUG),
        repo: z.string().regex(GITHUB_SLUG),
        since: z.number().int().nonnegative(),
        until: z.number().int().nonnegative(),
        model: z.string().min(1),
      })
      .strict()
      .superRefine((context, ctx) => {
        if (context.until < context.since) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["until"],
            message: "must be on or after since",
          });
        }
      }),
    facts: z.array(factSchema).min(1),
    expect: expectationSchema,
  })
  .strict();

export type EvalSignal = z.infer<typeof fixtureSchema>["signal"];
export type EvalHypothesisExpectation = z.infer<typeof expectationSchema>["hypothesis"];

/** One golden narrative case. `expect` is the only assertion surface. */
export type EvalCase = {
  id: string;
  signal: EvalSignal;
  context: {
    owner: string;
    repo: string;
    since: number;
    until: number;
    model: string;
  };
  /** Pinned from `NARRATIVE_PROMPT_VERSION`, not copied into the fixture JSON. */
  promptVersion: typeof NARRATIVE_PROMPT_VERSION;
  facts: Fact[];
  expect: {
    confidence: { min: number; max: number };
    requiredEvidence: readonly string[];
    hypothesis: EvalHypothesisExpectation;
  };
};

function fixturesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixtures");
}

function issuePath(issue: z.ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join(".") : "(root)";
}

function parseFixture(fileName: string, raw: unknown): EvalCase {
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issuePath(issue)}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid eval fixture ${fileName}: ${details}`);
  }

  const fixture = parsed.data;
  if (fileName !== `${fixture.id}.json`) {
    throw new Error(`Eval fixture ${fileName} id is ${fixture.id}`);
  }

  const ids = new Set<string>();
  for (const fact of fixture.facts) {
    if (ids.has(fact.id)) {
      throw new Error(`Invalid eval fixture ${fileName}: duplicate fact id ${fact.id}`);
    }
    ids.add(fact.id);
  }
  for (const id of fixture.expect.requiredEvidence) {
    if (!ids.has(id)) {
      throw new Error(`Invalid eval fixture ${fileName}: required evidence ${id} is not a fact`);
    }
  }

  return {
    id: fixture.id,
    signal: fixture.signal,
    context: fixture.context,
    promptVersion: NARRATIVE_PROMPT_VERSION,
    facts: fixture.facts,
    expect: fixture.expect,
  };
}

/**
 * Golden fact scenarios for the narrative eval. Loaded from `eval/fixtures/*.json`.
 * T25 asserts `expect` only — confidence band, required fact ids, hypothesis presence.
 */
export function loadEvalCases(dir: string = fixturesDir()): readonly EvalCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const cases = files.map((fileName) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, fileName), "utf8"));
    return parseFixture(fileName, raw);
  });
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) {
      throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    }
    ids.add(evalCase.id);
  }
  return cases;
}

export const evalCases: readonly EvalCase[] = loadEvalCases();
