/** Citeable metric kinds. The id segment after `fact:` is one of these. */
export const FACT_KINDS = [
  "rubberstamp",
  "reciprocity",
  "cycletime",
  "loadbalance",
  "leaderboard",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/** Units the narrative and the tables can render without guessing. */
export const FACT_UNITS = ["ratio", "seconds", "reviews", "pull_requests", "people"] as const;

export type FactUnit = (typeof FACT_UNITS)[number];

/**
 * One addressable number. `/narrative` may cite `id` and nothing else.
 * `id` is always `fact:<kind>:<subject>`.
 */
export type Fact = {
  /** Stable for the same metric rows. Unique within one response. */
  id: string;
  kind: FactKind;
  /** The part of `id` after `fact:<kind>:`. Logins are used as stored, not lowercased. */
  subject: string;
  /**
   * Null when that metric has no sample.
   * A missing stage or an empty team is not a zero — zero would look like a real measurement.
   */
  value: number | null;
  unit: FactUnit;
  /** Deterministic description shown to the model beside the value. No pull-request titles. */
  detail: string;
};
