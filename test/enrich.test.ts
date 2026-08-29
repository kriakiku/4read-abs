import { describe, expect, test } from "bun:test";
import { inferVolumeHint, isMostlyLatin, parseSequenceNumber } from "../src/enrich/latin.ts";

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
});
