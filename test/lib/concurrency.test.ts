import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/lib/concurrency.js";

/** Resolve after a microtask so overlapping calls actually interleave. */
function defer<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of when each item settles", async () => {
    const delays = [30, 5, 20, 1];
    const results = await mapWithConcurrency(delays, 2, (ms) => {
      return new Promise<number>((resolve) => setTimeout(() => resolve(ms * 2), ms));
    });
    expect(results).toEqual([60, 10, 40, 2]);
  });

  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const result = await defer(value);
      inFlight -= 1;
      return result;
    });
    expect(peak).toBe(3);
  });

  it("treats a limit below 1 as 1 and still completes", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (value) => defer(value * 10));
    expect(results).toEqual([10, 20, 30]);
  });

  it("resolves to an empty array without calling fn for empty input", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async (value) => {
      calls += 1;
      return value;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("rejects when any item rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("boom");
        return defer(value);
      }),
    ).rejects.toThrow("boom");
  });
});
