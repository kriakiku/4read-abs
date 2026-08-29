import { describe, expect, test } from "bun:test";
import {
  matchScore,
  normaliseName,
  normaliseTitle,
  safeFileName,
  similarity,
  transliterate,
  workIdentity,
} from "../src/catalog/normalize.ts";
import { groupByWork, pickBestEdition, scoreEdition } from "../src/catalog/select.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";
import { configSchema, type Config } from "../src/config.ts";

function config(overrides: Partial<Config> = {}): Config {
  return configSchema.parse(overrides);
}

function book(partial: Partial<BookWithPeople> & { source_id: number }): BookWithPeople {
  return {
    source_id: partial.source_id,
    url: `https://4read.org/${partial.source_id}-x.html`,
    slug: "x",
    title: partial.title ?? "Title",
    subtitle: null,
    description: partial.description ?? null,
    cover_url: partial.cover_url ?? null,
    duration_sec: partial.duration_sec ?? null,
    rating: partial.rating ?? null,
    votes: partial.votes ?? null,
    series_key: partial.series_key ?? null,
    series_name: partial.series_name ?? null,
    series_seq: partial.series_seq ?? null,
    published_year: partial.published_year ?? null,
    lastmod: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    fetched_at: null,
    content_hash: null,
    work_key: partial.work_key ?? null,
    work_label: null,
    isbn: null,
    asin: null,
    hardcover_book_id: null,
    hardcover_slug: null,
    detail_state: partial.detail_state ?? "ok",
    detail_error: null,
    authors: partial.authors ?? [],
    narrators: partial.narrators ?? [],
    genres: partial.genres ?? [],
    tags: partial.tags ?? [],
  };
}

describe("normalisation", () => {
  test("folds the many spellings of a volume marker onto one token", () => {
    const a = normaliseTitle("Гаррі Поттер і методи раціональности. Книга 2");
    const b = normaliseTitle("Гаррі Поттер і методи раціональности (Т. 2)");
    const c = normaliseTitle("Гаррі Поттер і методи раціональности, частина II");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("#2");
  });

  test("keeps different volumes apart", () => {
    expect(normaliseTitle("Стовпи Землі. Частина I")).not.toBe(normaliseTitle("Стовпи Землі. Частина II"));
  });

  test("does not invent a volume when there is none", () => {
    expect(normaliseTitle("Тіні забутих предків")).toBe("тіні забутих предків");
  });

  test("strips the audiobook prefix and punctuation", () => {
    expect(normaliseTitle("Аудіокнига «Кайдашева сім'я»")).toBe("кайдашева сімя");
  });

  test("transliterates Ukrainian text", () => {
    expect(transliterate("Характерник")).toBe("kharakternyk");
    expect(transliterate("Щастя")).toBe("shchastia");
  });

  test("names lose case and punctuation", () => {
    expect(normaliseName("Юдковскі, Елізер")).toBe("юдковскі елізер");
  });

  test("work identity ignores the narrator but not the volume", () => {
    const first = workIdentity(["Елізер Юдковскі"], "Гаррі Поттер і методи раціональности. Книга 2");
    const same = workIdentity(["Елізер Юдковскі"], "Гаррі Поттер і методи раціональности (Т. 2)");
    const other = workIdentity(["Елізер Юдковскі"], "Гаррі Поттер і методи раціональности. Книга 1");

    expect(first.key).toBe(same.key);
    expect(first.key).not.toBe(other.key);
  });

  test("similarity is bounded and symmetric", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
    expect(similarity("Пані Боварі", "Панi Боварi")).toBeGreaterThan(0.5);
  });

  test("match score tolerates transliterated library folders", () => {
    const score = matchScore(
      { title: "Пані Боварі", authors: ["Гюстав Флобер"] },
      { title: "Pani Bovari", authors: ["Hiustav Flober"] },
    );
    expect(score).toBeGreaterThan(0.8);
  });

  test("match score rejects unrelated books", () => {
    const score = matchScore(
      { title: "Пані Боварі", authors: ["Гюстав Флобер"] },
      { title: "Дюна", authors: ["Френк Герберт"] },
    );
    expect(score).toBeLessThan(0.3);
  });

  test("folder names stay filesystem safe", () => {
    expect(safeFileName('Bad/Name: "with" *chars*')).toBe("Bad Name with chars");
    expect(safeFileName("   ")).toBe("untitled");
    expect(safeFileName("a".repeat(200)).length).toBe(120);
  });
});

describe("edition selection", () => {
  const preferred = book({
    source_id: 1,
    title: "Дюна",
    authors: ["Френк Герберт"],
    narrators: ["Характерник"],
    rating: 3.5,
    votes: 60,
    work_key: "w1",
  });
  const higherRated = book({
    source_id: 2,
    title: "Дюна",
    authors: ["Френк Герберт"],
    narrators: ["Хтось Інший"],
    rating: 5,
    votes: 400,
    work_key: "w1",
  });
  const blocked = book({
    source_id: 3,
    title: "Дюна",
    authors: ["Френк Герберт"],
    narrators: ["Небажаний Диктор"],
    rating: 5,
    votes: 900,
    work_key: "w1",
  });

  test("a favourite narrator beats a better rated reading", () => {
    const chosen = pickBestEdition([higherRated, preferred], config({ narrators: { prefer: ["Характерник"], block: [] } }));
    expect(chosen!.book.source_id).toBe(1);
    expect(chosen!.preferredNarrator).toBe("Характерник");
  });

  test("rating decides when no narrator is preferred", () => {
    const chosen = pickBestEdition([preferred, higherRated], config());
    expect(chosen!.book.source_id).toBe(2);
  });

  test("earlier entries in the prefer list win", () => {
    const settings = config({ narrators: { prefer: ["Хтось Інший", "Характерник"], block: [] } });
    expect(pickBestEdition([preferred, higherRated], settings)!.book.source_id).toBe(2);
  });

  test("blocked narrators are dropped when an alternative exists", () => {
    const settings = config({ narrators: { prefer: [], block: ["Небажаний Диктор"] } });
    const chosen = pickBestEdition([blocked, preferred], settings);
    expect(chosen!.book.source_id).toBe(1);
    expect(scoreEdition(blocked, settings).blocked).toBe(true);
  });

  test("a blocked reading is still returned when it is the only one", () => {
    const settings = config({ narrators: { prefer: [], block: ["Небажаний Диктор"] } });
    expect(pickBestEdition([blocked], settings)!.book.source_id).toBe(3);
  });

  test("votes damp the rating so one enthusiastic vote does not win", () => {
    const lonely = book({
      source_id: 4,
      title: "Дюна",
      authors: ["Френк Герберт"],
      narrators: ["Хтось"],
      rating: 5,
      votes: 1,
      work_key: "w1",
    });
    const popular = book({
      source_id: 5,
      title: "Дюна",
      authors: ["Френк Герберт"],
      narrators: ["Інший"],
      rating: 4.4,
      votes: 300,
      work_key: "w1",
    });
    expect(pickBestEdition([lonely, popular], config())!.book.source_id).toBe(5);
  });

  test("grouping collapses readings of one work and keeps distinct works apart", () => {
    const other = book({ source_id: 9, title: "Месія Дюни", authors: ["Френк Герберт"], work_key: "w2" });
    const groups = groupByWork([preferred, higherRated, other], config());
    expect(groups).toHaveLength(2);
    const first = groups.find((group) => group.workKey === "w1")!;
    expect(first.alternatives).toHaveLength(1);
  });

  test("books without a work key are never merged", () => {
    const a = book({ source_id: 11, title: "Невідоме", work_key: null });
    const b = book({ source_id: 12, title: "Невідоме", work_key: null });
    expect(groupByWork([a, b], config())).toHaveLength(2);
  });
});
