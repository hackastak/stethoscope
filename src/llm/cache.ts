import { createHash } from "node:crypto";
import type { Fact } from "../facts/types.js";
import type { NarrativeOutput } from "../schemas/narrative.js";

/**
 * Process-local narrative cache. The key is the ticket's tuple; factsHash is the
 * content half. A restart misses and pays for one new call. Decisions Q28, Q30.
 */
export type NarrativeCacheKey = {
  owner: string;
  repo: string;
  since: number;
  until: number;
  factsHash: string;
  promptVersion: string;
  model: string;
};

export interface NarrativeCache {
  get(key: NarrativeCacheKey): NarrativeOutput | undefined;
  set(key: NarrativeCacheKey, value: NarrativeOutput): void;
}

type PromptVisibleFact = {
  id: string;
  value: number | null;
  unit: Fact["unit"];
  detail: string;
};

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** SHA-256 of the fields the prompt shows, sorted by id. Order in the caller's array does not matter. */
export function hashFacts(facts: readonly Fact[]): string {
  const rows: PromptVisibleFact[] = [...facts]
    .sort((left, right) => compareId(left.id, right.id))
    .map((fact) => ({
      id: fact.id,
      value: fact.value,
      unit: fact.unit,
      detail: fact.detail,
    }));
  return createHash("sha256")
    .update(`narrative-facts-v1:${JSON.stringify(rows)}`)
    .digest("hex");
}

export function serializeNarrativeCacheKey(key: NarrativeCacheKey): string {
  return JSON.stringify([
    key.owner,
    key.repo,
    key.since,
    key.until,
    key.factsHash,
    key.promptVersion,
    key.model,
  ]);
}

export function copyNarrative(value: NarrativeOutput): NarrativeOutput {
  return {
    narrative: value.narrative,
    hypothesis: value.hypothesis,
    confidence: value.confidence,
    evidence: [...value.evidence],
  };
}

export function createMemoryNarrativeCache(): NarrativeCache {
  const entries = new Map<string, NarrativeOutput>();
  return {
    get(key) {
      const stored = entries.get(serializeNarrativeCacheKey(key));
      return stored === undefined ? undefined : copyNarrative(stored);
    },
    set(key, value) {
      entries.set(serializeNarrativeCacheKey(key), copyNarrative(value));
    },
  };
}
