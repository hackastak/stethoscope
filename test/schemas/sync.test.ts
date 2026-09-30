import { describe, expect, it } from "vitest";
import { parseInstant } from "../../src/schemas/sync.js";

describe("parseInstant", () => {
  describe("numbers are unix epoch seconds", () => {
    it.each([
      [0, 0],
      [1_700_000_000, 1_700_000_000],
      [-1, null], // negative is not a valid epoch
      [1.5, null], // must be an integer
      [Number.NaN, null], // NaN is not an integer
    ])("parseInstant(%p) -> %p", (input, expected) => {
      expect(parseInstant(input)).toBe(expected);
    });
  });

  describe("date-only strings are UTC midnight", () => {
    it.each<[string, number | null]>([
      ["2023-11-01", Date.UTC(2023, 10, 1) / 1000],
      ["2024-02-29", Date.UTC(2024, 1, 29) / 1000], // leap year
      ["2023-02-29", null], // not a leap year
      ["2023-02-30", null], // February never has 30 days
      ["2023-11-31", null], // November has 30 days
      ["2023-13-01", null], // month out of range
      ["2023-00-10", null], // month 00
      ["2023-11-00", null], // day 00
    ])("parseInstant(%p) -> %p", (input, expected) => {
      expect(parseInstant(input)).toBe(expected);
    });
  });

  describe("date-time strings must carry a timezone and real clock parts", () => {
    it.each<[string, number | null]>([
      ["2023-11-01T12:30:45Z", Math.floor(Date.parse("2023-11-01T12:30:45Z") / 1000)],
      [
        "2023-11-01T12:30:45+05:00",
        Math.floor(Date.parse("2023-11-01T12:30:45+05:00") / 1000),
      ],
      ["2023-11-01T12:30:45", null], // no timezone
      ["2023-11-01T24:00:00Z", null], // hour 24
      ["2023-11-01T12:60:00Z", null], // minute 60
      ["2023-11-01T12:30:60Z", null], // second 60
      ["2023-13-01T00:00:00Z", null], // bad calendar date
    ])("parseInstant(%p) -> %p", (input, expected) => {
      expect(parseInstant(input)).toBe(expected);
    });

    it("truncates sub-second precision to whole seconds", () => {
      const whole = parseInstant("2023-11-01T12:30:45Z");
      expect(parseInstant("2023-11-01T12:30:45.999Z")).toBe(whole);
      expect(parseInstant("2023-11-01T12:30:45.1Z")).toBe(whole);
    });
  });

  describe("anything else is null", () => {
    it.each<[string, null]>([
      ["yesterday", null],
      ["", null],
      ["2023-11", null], // partial date
      ["2023/11/01", null], // wrong separator
      ["1700000000", null], // a numeric string is not parsed here; the schema converts it first
    ])("parseInstant(%p) -> %p", (input, expected) => {
      expect(parseInstant(input)).toBe(expected);
    });
  });
});
