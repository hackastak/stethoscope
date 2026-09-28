import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evalCases, loadEvalCases, type EvalCase } from "../../eval/cases.js";
import { NARRATIVE_PROMPT_VERSION } from "../../src/llm/prompt.js";

function byId(id: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.id === id);
  if (!found) throw new Error(`missing case ${id}`);
  return found;
}

function factValue(evalCase: EvalCase, id: string): number | null {
  const fact = evalCase.facts.find((entry) => entry.id === id);
  if (!fact) throw new Error(`${evalCase.id} missing ${id}`);
  return fact.value;
}

describe("eval cases", () => {
  it("loads 4–6 fixtures covering clear and insufficient signal", () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(4);
    expect(evalCases.length).toBeLessThanOrEqual(6);
    expect(evalCases.some((evalCase) => evalCase.signal === "clear")).toBe(true);
    expect(evalCases.some((evalCase) => evalCase.signal === "insufficient")).toBe(true);
    expect(evalCases.map((evalCase) => evalCase.id)).toEqual(
      [...evalCases.map((evalCase) => evalCase.id)].sort(),
    );
  });

  it("expresses expectations as bands, required ids, and hypothesis presence", () => {
    for (const evalCase of evalCases) {
      expect(evalCase.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
      expect(evalCase.expect.confidence.min).toBeLessThanOrEqual(evalCase.expect.confidence.max);
      expect(evalCase.expect.hypothesis).toMatch(/^(required|null)$/);
      for (const id of evalCase.expect.requiredEvidence) {
        expect(evalCase.facts.some((fact) => fact.id === id)).toBe(true);
      }
      expect(Object.keys(evalCase.expect).sort()).toEqual([
        "confidence",
        "hypothesis",
        "requiredEvidence",
      ]);
    }
  });

  it("rejects a fixture whose required id is not in the facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "stethoscope-eval-"));
    const { promptVersion: _promptVersion, ...fixture } = byId("insufficient-data");
    writeFileSync(
      join(dir, "insufficient-data.json"),
      JSON.stringify({
        ...fixture,
        expect: { ...fixture.expect, requiredEvidence: ["fact:rubberstamp:ada"] },
      }),
    );
    expect(() => loadEvalCases(dir)).toThrow(
      /required evidence fact:rubberstamp:ada is not a fact/,
    );
  });

  it("pins an obvious rubber-stamp as a clear, high-confidence citation", () => {
    const evalCase = byId("rubber-stamp");
    expect(evalCase.signal).toBe("clear");
    expect(evalCase.expect.hypothesis).toBe("required");
    expect(evalCase.expect.confidence.min).toBeGreaterThanOrEqual(0.7);
    expect(factValue(evalCase, "fact:rubberstamp:ada")).toBe(1);
    expect(factValue(evalCase, "fact:rubberstamp:grace")).toBe(0);
    expect(evalCase.expect.requiredEvidence).toContain("fact:rubberstamp:ada");
  });

  it("pins a balanced team as a clear description with no required cause", () => {
    const evalCase = byId("balanced-team");
    expect(evalCase.signal).toBe("clear");
    expect(evalCase.expect.hypothesis).toBe("null");
    expect(factValue(evalCase, "fact:reciprocity:ada")).toBe(1);
    expect(factValue(evalCase, "fact:reciprocity:grace")).toBe(1);
    expect(factValue(evalCase, "fact:loadbalance:reviews_gini")).toBe(0);
    expect(factValue(evalCase, "fact:rubberstamp:ada")).toBe(0);
  });

  it("pins a one-way silo above the interaction threshold", () => {
    const evalCase = byId("one-way-silo");
    expect(evalCase.signal).toBe("clear");
    expect(evalCase.expect.hypothesis).toBe("required");
    expect(factValue(evalCase, "fact:reciprocity:ada->grace")).toBeGreaterThanOrEqual(3);
    expect(factValue(evalCase, "fact:reciprocity:ada")).toBe(0);
    expect(factValue(evalCase, "fact:reciprocity:grace")).toBe(0);
    expect(evalCase.facts.some((fact) => fact.id === "fact:reciprocity:grace->ada")).toBe(false);
    expect(factValue(evalCase, "fact:rubberstamp:ada")).toBe(0);
  });

  it("pins a first-review stall separately from rubber-stamping", () => {
    const evalCase = byId("cycle-stall");
    expect(evalCase.signal).toBe("clear");
    expect(evalCase.expect.hypothesis).toBe("required");
    expect(factValue(evalCase, "fact:cycletime:first_review_p50")).toBe(86_400);
    expect(factValue(evalCase, "fact:cycletime:approval_to_merge_p50")).toBe(100);
    expect(factValue(evalCase, "fact:rubberstamp:ada")).toBe(0);
  });

  it("treats a single extreme approval as insufficient, not a pattern", () => {
    const evalCase = byId("noisy-sample");
    expect(evalCase.signal).toBe("insufficient");
    expect(evalCase.expect.hypothesis).toBe("null");
    expect(evalCase.expect.confidence.max).toBeLessThanOrEqual(0.4);
    expect(factValue(evalCase, "fact:rubberstamp:ada")).toBe(1);
    expect(factValue(evalCase, "fact:cycletime:first_review_n")).toBe(1);
    expect(factValue(evalCase, "fact:reciprocity:ada->grace")).toBe(1);
  });

  it("treats an empty window as insufficient with no required citation", () => {
    const evalCase = byId("insufficient-data");
    expect(evalCase.signal).toBe("insufficient");
    expect(evalCase.expect.hypothesis).toBe("null");
    expect(evalCase.expect.confidence.max).toBeLessThanOrEqual(0.2);
    expect(evalCase.expect.requiredEvidence).toEqual([]);
    expect(factValue(evalCase, "fact:cycletime:first_review_p50")).toBeNull();
    expect(factValue(evalCase, "fact:cycletime:first_review_n")).toBe(0);
    expect(factValue(evalCase, "fact:loadbalance:reviews_gini")).toBeNull();
    expect(evalCase.facts.some((fact) => fact.kind === "rubberstamp")).toBe(false);
  });
});
