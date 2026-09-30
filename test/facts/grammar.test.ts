import { describe, expect, it } from "vitest";
import {
  cycleTimeSubject,
  factId,
  factKindOf,
  isTableFactId,
  leaderboardSubject,
  rubberStampPairSubject,
  rubberStampReviewerSubject,
} from "../../src/facts/grammar.js";

describe("fact id grammar", () => {
  it("mints ids as fact:<kind>:<subject> from the subject builders", () => {
    expect(factId("leaderboard", leaderboardSubject("reviewers", "ada"))).toBe(
      "fact:leaderboard:reviewers:ada",
    );
    expect(factId("rubberstamp", rubberStampReviewerSubject("ada"))).toBe("fact:rubberstamp:ada");
    expect(factId("rubberstamp", rubberStampPairSubject("ada", "bea"))).toBe(
      "fact:rubberstamp:ada->bea",
    );
    expect(factId("cycletime", cycleTimeSubject("first_review", "p50"))).toBe(
      "fact:cycletime:first_review_p50",
    );
  });

  it("reads the kind of a fact id, or null for a non-fact string", () => {
    expect(factKindOf("fact:leaderboard:reviewers:ada")).toBe("leaderboard");
    expect(factKindOf("fact:reciprocity:ada->bea")).toBe("reciprocity");
    expect(factKindOf("fact:bogus:x")).toBeNull();
    expect(factKindOf("not-a-fact")).toBeNull();
  });

  it("links only kinds that have a table cell", () => {
    expect(isTableFactId("fact:leaderboard:reviewers:ada")).toBe(true);
    expect(isTableFactId("fact:rubberstamp:ada")).toBe(true);
    expect(isTableFactId("fact:cycletime:first_review_p50")).toBe(true);
    expect(isTableFactId("fact:reciprocity:ada->bea")).toBe(false);
    expect(isTableFactId("fact:loadbalance:reviews_gini")).toBe(false);
  });
});
