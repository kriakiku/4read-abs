import { describe, expect, test } from "bun:test";
import { parseBookPage } from "../src/source/book.ts";
import { parseListingPage } from "../src/source/listing.ts";
import { parseEntityIndex } from "../src/source/indexes.ts";
import { parseBookSitemap, parseSitemapIndex, isArticleSitemapUrl } from "../src/source/sitemap.ts";
import {
  parseBookUrl,
  parseCategoryKey,
  parseDurationToSeconds,
  parseTagKey,
  parseXfsearchKey,
  xfsearchUrl,
} from "../src/source/urls.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("url helpers", () => {
  test("extracts id and slug from an article url", () => {
    expect(parseBookUrl("https://4read.org/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html")).toEqual({
      sourceId: 6840,
      slug: "mskingbean89-vsi-molodi-chuvaki-pershij-rik",
      url: "https://4read.org/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html",
    });
  });

  test("rejects non-article urls", () => {
    expect(parseBookUrl("https://4read.org/zarubizhna/")).toBeNull();
    expect(parseBookUrl("https://4read.org/avtors.html")).toBeNull();
    expect(parseBookUrl(undefined)).toBeNull();
  });

  test("decodes facet keys", () => {
    expect(parseXfsearchKey("https://4read.org/xfsearch/avtor/mskingbean89/", "avtor")).toBe("mskingbean89");
    expect(
      parseXfsearchKey(
        "https://4read.org/xfsearch/cikl/%D0%B3%D0%B0%D1%80%D1%80%D1%96%20%D0%BF%D0%BE%D1%82%D1%82%D0%B5%D1%80/",
        "cikl",
      ),
    ).toBe("гаррі поттер");
    expect(parseXfsearchKey("https://4read.org/xfsearch/avtor/x/", "chitaet")).toBeNull();
  });

  test("round trips facet urls", () => {
    expect(xfsearchUrl("cikl", "all the young dudes")).toBe("https://4read.org/xfsearch/cikl/all%20the%20young%20dudes/");
    expect(xfsearchUrl("chitaet", "характерник", 3)).toContain("/page/3/");
  });

  test("identifies category and tag links", () => {
    expect(parseCategoryKey("https://4read.org/fentezi/")).toBe("fentezi");
    expect(parseCategoryKey("https://4read.org/blog/")).toBeNull();
    expect(parseCategoryKey("https://4read.org/xfsearch/avtor/x/")).toBeNull();
    expect(parseTagKey("https://4read.org/tags/all%20the%20young%20dudes/")).toBe("all the young dudes");
  });

  test("parses durations", () => {
    expect(parseDurationToSeconds("05:28:52")).toBe(19732);
    expect(parseDurationToSeconds("28:25")).toBe(1705);
    expect(parseDurationToSeconds(null)).toBeNull();
    expect(parseDurationToSeconds("nonsense")).toBeNull();
  });
});

describe("book page parser", () => {
  test("reads every field from a fanfiction release with a series", async () => {
    const html = await fixture("book-6840-vsi-molodi-chuvaki.html");
    const book = parseBookPage(html, "https://4read.org/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html");

    expect(book).not.toBeNull();
    expect(book!.sourceId).toBe(6840);
    // The h1 prefixes "Аудіокнига" and appends the author, so og:title is the reliable source.
    expect(book!.title).toBe("Всі молоді чуваки: Перший рік");
    expect(book!.authors).toEqual([{ key: "mskingbean89", name: "MsKingBean89" }]);
    expect(book!.narrators).toEqual([{ key: "boogagaрня", name: "BooGaGaрня" }]);
    expect(book!.series).toEqual({ key: "all the young dudes", name: "All the Young Dudes", sequence: "1" });
    expect(book!.genres.map((genre) => genre.key)).toEqual(["zarubizhna", "prygody", "roman", "fentezi", "xz"]);
    expect(book!.durationSec).toBe(19732);
    expect(book!.coverUrl).toBe("https://4read.org/uploads/posts/2026-01/vsi-molodi-chuvaky-pershyi-rik.webp");
    expect(book!.rating).toBeCloseTo(4.6, 5);
    expect(book!.votes).toBe(34);
    expect(book!.tags).toContain("All the Young Dudes");
  });

  test("keeps the synopsis and drops the series index and donation links", async () => {
    const html = await fixture("book-6840-vsi-molodi-chuvaki.html");
    const book = parseBookPage(html, "https://4read.org/6840-x.html")!;

    expect(book.description).toContain("Найбільший і дуже довгий фанфік");
    // The "Всі частини" heading and everything after it is navigation, not description.
    expect(book.description).not.toContain("Всі частини");
    expect(book.description).not.toMatch(/BuyMeACoffee|Patreon|Підтрим/);
    // Paragraphs separated only by <br> must not run together.
    expect(book.description).not.toContain("Ремуса.Відхилення");
  });

  test("collects sibling volumes linked from the description", async () => {
    const html = await fixture("book-6840-vsi-molodi-chuvaki.html");
    const book = parseBookPage(html, "https://4read.org/6840-x.html")!;
    expect(book.relatedBookIds).toContain(6862);
    expect(book.relatedBookIds).toContain(6948);
    expect(book.relatedBookIds).not.toContain(6840);
  });

  test("reads a volume whose title carries the book number", async () => {
    const html = await fixture("book-3130-hpmor-2.html");
    const book = parseBookPage(html, "https://4read.org/3130-x.html")!;

    expect(book.sourceId).toBe(3130);
    expect(book.title).toBe("Гаррі Поттер і методи раціональности. Книга 2");
    expect(book.authors[0]!.name).toBe("Елізер Юдковскі");
    expect(book.narrators[0]!.name).toBe("Характерник");
    expect(book.series).toEqual({ key: "гаррі поттер", name: "Гаррі Поттер", sequence: "2" });
    expect(book.durationSec).toBe(42486);
  });

  test("returns null for pages that are not books", () => {
    expect(parseBookPage("<html><body><h1>Blog post</h1></body></html>", "https://4read.org/8130-x.html")).toBeNull();
  });
});

describe("listing parser", () => {
  test("reads cards and pager from a category page", async () => {
    const html = await fixture("listing-category-page2.html");
    const listing = parseListingPage(html);

    expect(listing.cards.length).toBeGreaterThan(10);
    expect(listing.lastPage).toBe(95);
    const card = listing.cards.find((entry) => entry.sourceId === 8112);
    expect(card?.authorName).toBe("Бернар Вербер");
    expect(card?.durationSec).toBe(1705);
  });

  test("reads a series facet page", async () => {
    const html = await fixture("listing-series.html");
    const listing = parseListingPage(html);
    const ids = listing.cards.map((card) => card.sourceId);

    // The eight volumes of the series, and nothing from the sidebar blocks.
    expect(ids).toContain(6840);
    expect(ids).toContain(7270);
    expect(listing.cards.length).toBe(8);
    expect(listing.lastPage).toBe(1);
  });

  test("reads ratings from a narrator facet page", async () => {
    const html = await fixture("listing-narrator.html");
    const listing = parseListingPage(html);
    const card = listing.cards.find((entry) => entry.sourceId === 7560);

    expect(card?.title).toBe("Пані Боварі");
    expect(card?.rating).toBeCloseTo(4.2, 5);
    expect(card?.votes).toBe(26);
    expect(listing.lastPage).toBeGreaterThan(1);
  });
});

describe("entity indexes", () => {
  test("parses the author index with book counts", async () => {
    const entries = parseEntityIndex(await fixture("index-authors.html"), "avtor");
    expect(entries.length).toBeGreaterThan(1000);

    const christie = entries.find((entry) => entry.key === "агата крісті");
    expect(christie).toEqual({ key: "агата крісті", name: "Агата Крісті", bookCount: 27 });
  });

  test("parses the narrator index", async () => {
    const entries = parseEntityIndex(await fixture("index-readers.html"), "chitaet");
    expect(entries.length).toBeGreaterThan(500);

    const rogovtseva = entries.find((entry) => entry.key === "ада роговцева");
    expect(rogovtseva?.name).toBe("Ада Роговцева");
    expect(rogovtseva?.bookCount).toBe(23);
  });
});

describe("sitemap", () => {
  test("lists the child sitemaps", async () => {
    const children = parseSitemapIndex(await fixture("sitemap-index.xml"));
    expect(children).toContain("https://4read.org/news_pages.xml");
    expect(children.length).toBe(4);
  });

  test("keeps only the article news sitemap from the index", async () => {
    const children = parseSitemapIndex(await fixture("sitemap-index.xml")).filter(isArticleSitemapUrl);
    expect(children).toEqual(["https://4read.org/news_pages.xml"]);
  });

  test("extracts article urls with lastmod", async () => {
    const entries = parseBookSitemap(await fixture("sitemap-news.xml"));
    expect(entries.length).toBeGreaterThan(20);

    const newest = entries.find((entry) => entry.sourceId === 8176);
    expect(newest?.lastmod).toBe("2026-08-29T13:19:30+03:00");
    expect(newest?.slug).toBe("ocheret-drug-mij-virnij-samokat");
  });

  test("keeps the newest lastmod when an id repeats", () => {
    const xml = `<urlset>
      <url><loc>https://4read.org/1-a.html</loc><lastmod>2024-01-01T00:00:00+00:00</lastmod></url>
      <url><loc>https://4read.org/1-a.html</loc><lastmod>2025-01-01T00:00:00+00:00</lastmod></url>
    </urlset>`;
    const entries = parseBookSitemap(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lastmod).toBe("2025-01-01T00:00:00+00:00");
  });
});
