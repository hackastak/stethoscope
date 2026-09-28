import { describe, expect, it } from "vitest";
import {
  dateRangeBlockReason,
  defaultUtcDateRange,
  resolveUtcDateRange,
  splitOwnerRepo,
} from "../../src/components/range.js";

const NOW = Date.parse("2026-09-28T15:00:00.000Z");

describe("defaultUtcDateRange", () => {
  it("covers the last 30 UTC calendar days, including today", () => {
    expect(defaultUtcDateRange(NOW)).toEqual({
      since: "2026-08-29",
      until: "2026-09-28",
    });
  });
});

describe("resolveUtcDateRange", () => {
  it("starts at midnight and includes the whole until day", () => {
    expect(resolveUtcDateRange({ since: "2026-08-29", until: "2026-09-28" })).toEqual({
      since: "2026-08-29T00:00:00Z",
      until: "2026-09-28T23:59:59Z",
    });
  });

  it("allows a single day", () => {
    expect(resolveUtcDateRange({ since: "2026-09-28", until: "2026-09-28" })).toEqual({
      since: "2026-09-28T00:00:00Z",
      until: "2026-09-28T23:59:59Z",
    });
  });

  it("rejects a missing, malformed, or inverted range", () => {
    expect(resolveUtcDateRange({ since: "", until: "2026-09-28" })).toBeNull();
    expect(resolveUtcDateRange({ since: "2026-09-28", until: "" })).toBeNull();
    expect(resolveUtcDateRange({ since: "28-09-2026", until: "2026-09-28" })).toBeNull();
    expect(resolveUtcDateRange({ since: "2026-09-28", until: "2026-08-29" })).toBeNull();
  });
});

describe("dateRangeBlockReason", () => {
  it("names the missing-date and inverted cases", () => {
    expect(dateRangeBlockReason({ since: "", until: "2026-09-28" })).toBe(
      "Sync needs both a since and an until date.",
    );
    expect(dateRangeBlockReason({ since: "2026-09-28", until: "2026-08-01" })).toBe(
      "Until must be on or after since.",
    );
    expect(dateRangeBlockReason({ since: "2026-08-29", until: "2026-09-28" })).toBeNull();
  });
});

describe("splitOwnerRepo", () => {
  it("splits on the first slash and keeps an invalid slug for the API", () => {
    expect(splitOwnerRepo("  ada/scope  ")).toEqual({ owner: "ada", repo: "scope" });
    expect(splitOwnerRepo("bad slug")).toEqual({ owner: "bad slug", repo: "" });
    expect(splitOwnerRepo("ada/scope/extra")).toEqual({ owner: "ada", repo: "scope/extra" });
  });
});
