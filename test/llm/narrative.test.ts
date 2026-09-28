import { describe, expect, it } from "vitest";
import type { Fact } from "../../src/facts/types.js";
import { errorToProblem } from "../../src/lib/errors.js";
import {
  UngroundedNarrativeError,
  createMemoryNarrativeCache,
  hashFacts,
  synthesize,
  type NarrativeCache,
  type SynthesizeContext,
} from "../../src/llm/index.js";
import { LlmOutputError, LlmRequestError, type LLMProvider } from "../../src/llm/provider.js";
import { NARRATIVE_PROMPT_VERSION, renderNarrativePrompt } from "../../src/llm/prompt.js";
import type { NarrativeOutput } from "../../src/schemas/narrative.js";

function fact(overrides: Partial<Fact> & Pick<Fact, "id">): Fact {
  return {
    kind: "rubberstamp",
    subject: "alice",
    value: 0.5,
    unit: "ratio",
    detail: "Rubber-stamp rate for alice.",
    ...overrides,
  };
}

const alice = fact({ id: "fact:rubberstamp:alice" });
const cycle = fact({
  id: "fact:cycletime:first_review_p50",
  kind: "cycletime",
  subject: "first_review_p50",
  value: null,
  unit: "seconds",
  detail: "Median seconds from ready to first review.",
});

const grounded: NarrativeOutput = {
  narrative: "Alice approves half of her eligible reviews quickly.",
  hypothesis: "Review load is concentrated.",
  confidence: 0.7,
  evidence: [alice.id],
};

function scriptedProvider(
  script: Array<NarrativeOutput | Error>,
): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(prompt, schema) {
      prompts.push(prompt);
      const next = script[prompts.length - 1];
      if (!next) throw new Error("unexpected provider call");
      if (next instanceof Error) throw next;
      const parsed = schema.safeParse(next);
      if (!parsed.success) {
        throw new LlmOutputError("Narrative completion failed schema validation");
      }
      return parsed.data;
    },
  };
}

function context(
  provider: LLMProvider,
  cache: NarrativeCache = createMemoryNarrativeCache(),
  overrides: Partial<SynthesizeContext> = {},
): SynthesizeContext {
  return {
    provider,
    cache,
    owner: "acme",
    repo: "widgets",
    since: 1_700_000_000,
    until: 1_702_592_000,
    model: "claude-sonnet-5",
    ...overrides,
  };
}

describe("hashFacts", () => {
  it("is stable across input order and changes when a shown field changes", () => {
    expect(hashFacts([cycle, alice])).toBe(hashFacts([alice, cycle]));
    expect(hashFacts([alice, cycle])).toMatch(/^[a-f0-9]{64}$/);
    expect(hashFacts([{ ...alice, value: 0.1 }, cycle])).not.toBe(hashFacts([alice, cycle]));
    expect(hashFacts([{ ...alice, detail: "other" }])).not.toBe(hashFacts([alice]));
  });
});

describe("synthesize", () => {
  it("rejects a hallucinated fact id and never returns that completion", async () => {
    const invented = "fact:invented:nope";
    const provider = scriptedProvider([
      { ...grounded, narrative: "Invented a person.", evidence: [alice.id, invented] },
      { ...grounded, narrative: "Still invented.", evidence: [invented] },
    ]);

    await expect(synthesize([alice], context(provider))).rejects.toMatchObject({
      name: "UngroundedNarrativeError",
      statusCode: 502,
      code: "ungrounded",
      unknownIds: [invented],
    });
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[0]).toBe(renderNarrativePrompt([alice]));
    expect(provider.prompts[1]).toContain(`UNKNOWN_IDS: ${JSON.stringify([invented])}`);
    expect(provider.prompts[1]).not.toContain("Invented a person.");
    expect(provider.prompts[1]).toContain(alice.id);
  });

  it("does not cache a rejected citation, so the next call tries again", async () => {
    const invented = "fact:invented:nope";
    const provider = scriptedProvider([
      { ...grounded, evidence: [invented] },
      { ...grounded, evidence: [invented] },
      { ...grounded, evidence: [invented] },
      { ...grounded, evidence: [invented] },
    ]);
    const cache = createMemoryNarrativeCache();

    await expect(synthesize([alice], context(provider, cache))).rejects.toBeInstanceOf(
      UngroundedNarrativeError,
    );
    await expect(synthesize([alice], context(provider, cache))).rejects.toBeInstanceOf(
      UngroundedNarrativeError,
    );
    expect(provider.prompts).toHaveLength(4);
  });

  it("returns the corrected completion after one retry and then serves it from cache", async () => {
    const invented = "fact:invented:nope";
    const provider = scriptedProvider([
      { ...grounded, evidence: [invented] },
      grounded,
      { ...grounded, narrative: "should not be called" },
    ]);
    const cache = createMemoryNarrativeCache();
    const ctx = context(provider, cache);

    const first = await synthesize([alice, cycle], ctx);
    expect(first).toEqual(grounded);
    expect(first.evidence).not.toContain(invented);

    first.evidence.push(invented);
    first.narrative = "mutated";

    const second = await synthesize([cycle, alice], ctx);
    expect(second).toEqual(grounded);
    expect(provider.prompts).toHaveLength(2);
  });

  it("does not call the provider again for the same repo, window, facts, prompt version, and model", async () => {
    const provider = scriptedProvider([grounded, { ...grounded, narrative: "second call" }]);
    const cache = createMemoryNarrativeCache();

    await synthesize([alice], context(provider, cache));
    const hit = await synthesize([alice], context(provider, cache));

    expect(hit).toEqual(grounded);
    expect(provider.prompts).toHaveLength(1);
    expect(hit).not.toBe(grounded);
  });

  it("misses the cache when the repo, window, model, prompt version, or facts differ", async () => {
    const provider = scriptedProvider([
      grounded,
      grounded,
      grounded,
      grounded,
      grounded,
      grounded,
      grounded,
      grounded,
    ]);
    const cache = createMemoryNarrativeCache();
    const facts = [alice];

    await synthesize(facts, context(provider, cache));
    await synthesize(facts, context(provider, cache, { owner: "other" }));
    await synthesize(facts, context(provider, cache, { repo: "other" }));
    await synthesize(facts, context(provider, cache, { since: 1_700_000_001 }));
    await synthesize(facts, context(provider, cache, { until: 1_702_592_001 }));
    await synthesize(facts, context(provider, cache, { model: "claude-opus-5" }));
    await synthesize(facts, context(provider, cache, { promptVersion: "narrative-v0" }));
    await synthesize([{ ...alice, value: 0.2 }], context(provider, cache));

    expect(provider.prompts).toHaveLength(8);
  });

  it("rejects confidence outside 0–1 without a retry or a cache write", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async complete() {
        calls += 1;
        return {
          narrative: "out of range",
          hypothesis: null,
          confidence: 1.5,
          evidence: [],
        } as NarrativeOutput;
      },
    };
    const cache = createMemoryNarrativeCache();

    await expect(synthesize([alice], context(provider, cache))).rejects.toMatchObject({
      name: "LlmOutputError",
      statusCode: 502,
      code: "malformed_output",
    });
    expect(calls).toBe(1);

    await expect(synthesize([alice], context(provider, cache))).rejects.toBeInstanceOf(
      LlmOutputError,
    );
    expect(calls).toBe(2);
  });

  it("accepts confidence at both ends and an empty evidence list", async () => {
    const empty: NarrativeOutput = {
      narrative: "No sample supports a claim.",
      hypothesis: null,
      confidence: 0,
      evidence: [],
    };
    const certain: NarrativeOutput = { ...grounded, confidence: 1 };
    const provider = scriptedProvider([empty, certain]);
    const cache = createMemoryNarrativeCache();

    await expect(synthesize([alice], context(provider, cache))).resolves.toEqual(empty);
    await expect(
      synthesize([alice], context(provider, cache, { owner: "other" })),
    ).resolves.toEqual(certain);
  });

  it("does not retry a failed provider call", async () => {
    const provider = scriptedProvider([
      new LlmRequestError("Anthropic request failed: 503"),
      grounded,
    ]);

    await expect(synthesize([alice], context(provider))).rejects.toBeInstanceOf(LlmRequestError);
    expect(provider.prompts).toHaveLength(1);
  });

  it("propagates a request failure on the citation retry and does not cache it", async () => {
    const provider = scriptedProvider([
      { ...grounded, evidence: ["fact:invented:nope"] },
      new LlmRequestError("Anthropic request failed: 503"),
      grounded,
    ]);
    const cache = createMemoryNarrativeCache();

    await expect(synthesize([alice], context(provider, cache))).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    await expect(synthesize([alice], context(provider, cache))).resolves.toEqual(grounded);
    expect(provider.prompts).toHaveLength(3);
  });

  it("refuses duplicate fact ids before calling the provider", async () => {
    const provider = scriptedProvider([grounded]);

    await expect(synthesize([alice, alice], context(provider))).rejects.toThrow(
      "Duplicate fact id: fact:rubberstamp:alice",
    );
    expect(provider.prompts).toHaveLength(0);
  });

  it("does not mutate the caller's fact list", async () => {
    const facts = [cycle, alice];
    const provider = scriptedProvider([grounded]);

    await synthesize(facts, context(provider));
    expect(facts.map((item) => item.id)).toEqual([cycle.id, alice.id]);
  });

  it("maps an ungrounded narrative to a 502 problem without echoing a secret", () => {
    const error = new UngroundedNarrativeError(["fact:invented:nope"]);
    expect(errorToProblem(error, { production: true, secrets: ["sk-ant-secret"] })).toEqual({
      status: 502,
      error: "Bad Gateway",
      message: "Narrative cited unknown fact ids: fact:invented:nope",
    });
    expect(error.message).not.toContain("sk-ant-secret");
    expect(NARRATIVE_PROMPT_VERSION).toBe("narrative-v1");
  });
});
