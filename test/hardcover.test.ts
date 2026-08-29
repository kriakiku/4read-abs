import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { configSchema } from "../src/config.ts";
import { HardcoverClient } from "../src/enrich/hardcover.ts";
import { preferredCoverUrl } from "../src/covers.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.stop(true);
  }
});

function book(partial: Partial<BookWithPeople> = {}): BookWithPeople {
  return {
    source_id: 6840,
    url: "https://4read.org/6840-x.html",
    slug: "x",
    title: "Всі молоді чуваки: Перший рік",
    subtitle: null,
    description: null,
    cover_url: "https://4read.org/uploads/posts/cover.webp",
    duration_sec: null,
    rating: null,
    votes: null,
    series_key: "all the young dudes",
    series_name: "All the Young Dudes",
    series_seq: "1",
    published_year: null,
    lastmod: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    fetched_at: null,
    content_hash: null,
    work_key: null,
    work_label: null,
    isbn: null,
    asin: null,
    hardcover_book_id: null,
    hardcover_slug: null,
    hardcover_cover_url: "https://cdn.hardcover.app/covers/atyd1.jpg",
    hardcover_series_id: null,
    hardcover_match_kind: null,
    detail_state: "ok",
    detail_error: null,
    authors: ["MsKingBean89"],
    narrators: [],
    genres: [],
    tags: ["All the Young Dudes"],
    ...partial,
  };
}

describe("cover preference", () => {
  test("hardcover-first prefers CDN over 4read", () => {
    const config = configSchema.parse({ covers: { prefer: "hardcover-first" } });
    expect(preferredCoverUrl(book(), config)).toContain("hardcover.app");
  });

  test("hardcover-only ignores 4read covers", () => {
    const config = configSchema.parse({ covers: { prefer: "hardcover-only" } });
    expect(preferredCoverUrl(book({ hardcover_cover_url: null }), config)).toBeNull();
    expect(preferredCoverUrl(book(), config)).toContain("hardcover.app");
  });

  test("source prefer keeps 4read URLs", () => {
    const config = configSchema.parse({ covers: { prefer: "source" } });
    expect(preferredCoverUrl(book(), config)).toContain("4read.org");
  });
});

describe("Hardcover enrichment", () => {
  test("matches by English series position and skips compilation book ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-hc-"));
    try {
      const origin = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const body = (await request.json()) as { query?: string; variables?: Record<string, unknown> };
          const query = body.query ?? "";

          if (query.includes("query Search") && body.variables?.type === "Series") {
            return Response.json({
              data: {
                search: {
                  results: {
                    hits: [{ document: { id: 42, name: "All the Young Dudes", slug: "all-the-young-dudes" } }],
                  },
                },
              },
            });
          }

          if (query.includes("query SeriesBooks")) {
            return Response.json({
              data: {
                series_by_pk: {
                  id: 42,
                  slug: "all-the-young-dudes",
                  name: "All the Young Dudes",
                  book_series: [
                    {
                      position: 1,
                      compilation: false,
                      book: {
                        id: 1001,
                        slug: "all-the-young-dudes-year-one",
                        title: "All the Young Dudes: Year One",
                        release_year: 2018,
                        compilation: false,
                        image: { url: "https://cdn.hardcover.app/covers/y1.jpg" },
                        contributions: [{ author: { name: "MsKingBean89" } }],
                        editions: [{ isbn_13: "9780000000001", asin: null }],
                      },
                    },
                    {
                      position: 2,
                      compilation: true,
                      book: {
                        id: 1002,
                        slug: "all-the-young-dudes-volume-two",
                        title: "All the Young Dudes: Volume Two",
                        release_year: 2018,
                        compilation: true,
                        image: { url: "https://cdn.hardcover.app/covers/v2.jpg" },
                        contributions: [{ author: { name: "MsKingBean89" } }],
                        editions: [],
                      },
                    },
                  ],
                },
              },
            });
          }

          // Book searches can return empty; series path should be enough.
          if (query.includes("query Search")) {
            return Response.json({ data: { search: { results: { hits: [] } } } });
          }

          return Response.json({ data: {} });
        },
      });
      servers.push(origin);

      const db = openDb(join(dir, "data"));
      const config = configSchema.parse({
        hardcover: {
          enabled: true,
          apiKey: "test",
          endpoint: `http://127.0.0.1:${origin.port}/v1/graphql`,
        },
        ai: { enabled: false },
      });
      const client = new HardcoverClient(db, config);

      const yearOne = await client.enrich({
        title: "Всі молоді чуваки: Перший рік",
        authors: ["MsKingBean89"],
        seriesName: "All the Young Dudes",
        seriesSeq: "1",
        tags: ["All the Young Dudes"],
      });
      expect(yearOne.matchKind).toBe("series-position");
      expect(yearOne.bookId).toBe("1001");
      expect(yearOne.coverUrl).toContain("y1.jpg");
      expect(yearOne.seriesId).toBe("42");

      const yearTwo = await client.enrich({
        title: "Всі молоді чуваки: Другий рік",
        authors: ["MsKingBean89"],
        seriesName: "All the Young Dudes",
        seriesSeq: "2",
        tags: ["All the Young Dudes"],
      });
      // Packed Hardcover volume → cover only, no 1:1 book id (do not merge years 2–4).
      expect(yearTwo.matchKind).toBe("series-cover");
      expect(yearTwo.bookId).toBeNull();
      expect(yearTwo.coverUrl).toContain("v2.jpg");
      expect(yearTwo.compilation).toBe(true);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("asks AI only in the ambiguous band and respects compilation refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-ai-"));
    try {
      let aiCalls = 0;
      const origin = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/chat/completions")) {
            aiCalls += 1;
            return Response.json({
              choices: [{ message: { content: JSON.stringify({ index: null, confidence: 0.9, reason: "compilation" }) } }],
            });
          }

          const body = (await request.json()) as { query?: string };
          if ((body.query ?? "").includes("query Search")) {
            return Response.json({
              data: {
                search: {
                  results: {
                    hits: [
                      {
                        document: {
                          id: 9,
                          slug: "packed-volume",
                          title: "All the Young Dudes Volume Two",
                          author_names: ["MsKingBean89"],
                          compilation: true,
                          image: { url: "https://cdn.hardcover.app/covers/pack.jpg" },
                        },
                      },
                    ],
                  },
                },
              },
            });
          }
          return Response.json({ data: {} });
        },
      });
      servers.push(origin);

      const db = openDb(join(dir, "data"));
      const config = configSchema.parse({
        hardcover: {
          enabled: true,
          apiKey: "test",
          endpoint: `http://127.0.0.1:${origin.port}/v1/graphql`,
          acceptScore: 0.95,
        },
        ai: {
          enabled: true,
          apiKey: "sk-test",
          baseUrl: `http://127.0.0.1:${origin.port}/v1`,
          model: "mimo-v2.5",
          minScore: 0.4,
          maxScore: 0.95,
          maxCallsPerDay: 5,
          maxCallsPerHour: 5,
        },
      });
      const client = new HardcoverClient(db, config);
      const result = await client.enrich({
        title: "All the Young Dudes Year Two",
        authors: ["MsKingBean89"],
        seriesName: null,
        seriesSeq: "2",
      });

      expect(aiCalls).toBe(1);
      expect(result.bookId).toBeNull();
      expect(result.coverUrl).toContain("pack.jpg");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
