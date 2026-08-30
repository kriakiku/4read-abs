import { describe, expect, test } from "bun:test";
import {
  inferVolumeHint,
  isMostlyLatin,
  parseSequenceNumber,
  parseYearRange,
  yearRangeContains,
} from "../src/enrich/latin.ts";

describe("latin / volume helpers", () => {
  test("detects English series names and Ukrainian titles", () => {
    expect(isMostlyLatin("All the Young Dudes")).toBe(true);
    expect(isMostlyLatin("Всі молоді чуваки")).toBe(false);
    expect(isMostlyLatin("MsKingBean89")).toBe(true);
  });

  test("parses series sequence numbers", () => {
    expect(parseSequenceNumber("1")).toBe(1);
    expect(parseSequenceNumber("01")).toBe(1);
    expect(parseSequenceNumber("1.5")).toBe(1);
    expect(parseSequenceNumber("")).toBeNull();
  });

  test("infers volume hints from Ukrainian and English titles", () => {
    expect(inferVolumeHint("Всі молоді чуваки: Перший рік")).toBe(1);
    expect(inferVolumeHint("Всі молоді чуваки: Другий рік")).toBe(2);
    expect(inferVolumeHint("All the Young Dudes: Year Three")).toBe(3);
    expect(inferVolumeHint("Something Volume 4")).toBe(4);
  });

  test("parses packed year ranges", () => {
    const range = parseYearRange("All The Young Dudes - Volume Two: Years 5 - 7");
    expect(range).toEqual({ from: 5, to: 7 });
    expect(yearRangeContains(range!, 5)).toBe(true);
    expect(yearRangeContains(range!, 6)).toBe(true);
    expect(yearRangeContains(range!, 7)).toBe(true);
    expect(yearRangeContains(range!, 2)).toBe(false);
    expect(parseYearRange("All the Young Dudes: Year One")).toEqual({ from: 1, to: 1 });
  });
});
