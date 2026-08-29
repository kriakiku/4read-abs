import type { Config } from "../config.ts";
import { nowIso, type Db } from "../db.ts";
import { logger } from "../log.ts";
import { normaliseName, similarity, normaliseTitle } from "../catalog/normalize.ts";
import { AiMatcher } from "./ai.ts";
import { inferVolumeHint, isMostlyLatin, parseSequenceNumber, parseYearRange, yearRangeContains } from "./latin.ts";

const log = logger("hardcover");

export type HardcoverMatchKind = "book" | "series-position" | "series-cover" | "volume-pack" | "none";

export interface HardcoverEnrichment {
  bookId: string | null;
  slug: string | null;
  title: string | null;
  authorNames: string[];
  isbn: string | null;
  asin: string | null;
  releaseYear: string | null;
  coverUrl: string | null;
  seriesId: string | null;
  seriesSlug: string | null;
  matchKind: HardcoverMatchKind;
  score: number;
  compilation: boolean;
}

export interface EnrichmentInput {
  title: string;
  authors: string[];
  seriesName: string | null;
  seriesSeq: string | null;
  tags?: string[];
}

interface SearchHit {
  bookId: string | null;
  slug: string | null;
  title: string | null;
  authorNames: string[];
  isbn: string | null;
  asin: string | null;
  releaseYear: string | null;
  coverUrl: string | null;
  seriesNames: string[];
  compilation: boolean;
  score: number;
}

interface SeriesBook {
  bookId: string;
  slug: string | null;
  title: string;
  authorNames: string[];
  position: number | null;
  compilation: boolean;
  coverUrl: string | null;
  isbn: string | null;
  asin: string | null;
  releaseYear: string | null;
}

interface SeriesHit {
  seriesId: string;
  slug: string | null;
  name: string;
  books: SeriesBook[];
}

const SEARCH_QUERY = /* graphql */ `
  query Search($q: String!, $type: String!) {
    search(query: $q, query_type: $type, per_page: 10, page: 1) {
      results
    }
  }
`;

const BOOK_BY_ID_QUERY = /* graphql */ `
  query BookById($id: Int!) {
    books_by_pk(id: $id) {
      id
      slug
      title
      release_year
      compilation
      image { url }
      cached_image
      contributions { author { name } }
      editions(limit: 5, order_by: { users_count: desc }) {
        isbn_13
        isbn_10
        asin
      }
      book_series(limit: 3, where: { featured: { _eq: true } }) {
        position
        compilation
        series { id slug name }
      }
    }
  }
`;

const SERIES_BOOKS_QUERY = /* graphql */ `
  query SeriesBooks($id: Int!) {
    series_by_pk(id: $id) {
      id
      slug
      name
      book_series(
        distinct_on: position
        order_by: [{ position: asc }, { book: { users_count: desc } }]
        where: { book: { canonical_id: { _is_null: true }, is_partial_book: { _eq: false } } }
      ) {
        position
        compilation
        book {
          id
          slug
          title
          release_year
          compilation
          image { url }
          cached_image
          contributions { author { name } }
          editions(limit: 3, order_by: { users_count: desc }) {
            isbn_13
            isbn_10
            asin
          }
        }
      }
    }
  }
`;

interface GraphQlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string }>;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstString(record.url ?? record.name ?? record.title);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => firstString(entry)).filter((entry): entry is string => !!entry);
  const single = firstString(value);
  return single ? [single] : [];
}

function extractCoverUrl(document: Record<string, unknown>): string | null {
  const image = asRecord(document.image);
  if (image) {
    const url = firstString(image.url);
    if (url) return url;
  }
  const cached = asRecord(document.cached_image) ?? document.cached_image;
  if (typeof cached === "string" && cached.startsWith("http")) return cached;
  if (cached && typeof cached === "object") {
    const url = firstString((cached as Record<string, unknown>).url);
    if (url) return url;
  }
  return firstString(document.cover_image_url ?? document.image_url ?? document.image);
}

function extractHits(results: unknown): Array<Record<string, unknown>> {
  const root = asRecord(results);
  if (!root) return [];
  const hits = root.hits;
  if (!Array.isArray(hits)) return [];
  const documents: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    const record = asRecord(hit);
    if (!record) continue;
    documents.push(asRecord(record.document) ?? record);
  }
  return documents;
}

function hitToSearch(document: Record<string, unknown>): SearchHit {
  return {
    bookId: firstString(document.id),
    slug: firstString(document.slug),
    title: firstString(document.title),
    authorNames: stringArray(document.author_names ?? document.authors ?? document.contributions),
    isbn: firstString(document.isbns ?? document.isbn ?? document.isbn_13 ?? document.isbn13),
    asin: firstString(document.asin ?? document.asins),
    releaseYear: firstString(document.release_year ?? document.publication_year),
    coverUrl: extractCoverUrl(document),
    seriesNames: stringArray(document.series_names ?? document.series),
    compilation: Boolean(document.compilation),
    score: 0,
  };
}

function contributionsToNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const author = asRecord(record?.author);
    const name = firstString(author?.name ?? record?.name);
    if (name) names.push(name);
  }
  return names;
}

function editionsIds(value: unknown): { isbn: string | null; asin: string | null } {
  if (!Array.isArray(value)) return { isbn: null, asin: null };
  let isbn: string | null = null;
  let asin: string | null = null;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    isbn ??= firstString(record.isbn_13 ?? record.isbn_10);
    asin ??= firstString(record.asin);
  }
  return { isbn, asin };
}

/**
 * Optional enrichment that maps a source book onto Hardcover's canonical ids and cover CDN.
 * Prefer English series names from 4read over Ukrainian titles. Failures are always soft.
 */
export class HardcoverClient {
  private nextAllowedAt = 0;
  private disabledUntil = 0;
  private readonly ai: AiMatcher;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.ai = new AiMatcher(db, config);
  }

  get enabled(): boolean {
    return this.config.hardcover.enabled && this.config.hardcover.apiKey.length > 0;
  }

  private cacheGet(key: string): unknown | undefined {
    const row = this.db
      .query<{ response: string }, [string]>("select response from hardcover_cache where query_key = ?")
      .get(key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.response);
    } catch {
      return undefined;
    }
  }

  private cacheSet(key: string, value: unknown): void {
    this.db
      .query(
        `insert into hardcover_cache (query_key, response, fetched_at) values (?, ?, ?)
         on conflict(query_key) do update set response = excluded.response, fetched_at = excluded.fetched_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  private async pace(): Promise<void> {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.nextAllowedAt = Date.now() + 1100;
  }

  private async graphql(query: string, variables: Record<string, unknown>, cacheKey?: string): Promise<unknown> {
    if (cacheKey) {
      const cached = this.cacheGet(cacheKey);
      if (cached !== undefined) return cached;
    }

    await this.pace();
    const response = await fetch(this.config.hardcover.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.config.hardcover.apiKey,
        "user-agent": "4read-abs (audiobook metadata sync)",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
      this.disabledUntil = Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000;
      throw new Error(`rate limited, backing off ${retryAfter}s`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as GraphQlResponse;
    if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
    if (payload.error) throw new Error(payload.error);

    if (cacheKey) this.cacheSet(cacheKey, payload.data ?? null);
    return payload.data ?? null;
  }

  private async search(q: string, type: "Book" | "Series"): Promise<unknown> {
    const cacheKey = `search:${type}:${q.toLowerCase()}`;
    const data = (await this.graphql(SEARCH_QUERY, { q, type }, cacheKey)) as Record<string, unknown> | null;
    return asRecord(data)?.search ? asRecord(asRecord(data)!.search)?.results : null;
  }

  private scoreHit(hit: SearchHit, input: EnrichmentInput, queryHadSeries: boolean): number {
    const wantedTitle = normaliseTitle(input.title);
    const wantedAuthors = input.authors.map((name) => normaliseName(name));
    const titleScore = hit.title ? similarity(wantedTitle, normaliseTitle(hit.title)) : 0;

    let authorScore = 0;
    if (wantedAuthors.length && hit.authorNames.length) {
      for (const one of wantedAuthors) {
        for (const other of hit.authorNames) {
          authorScore = Math.max(authorScore, similarity(one, normaliseName(other)));
        }
      }
    }

    let seriesBoost = 0;
    if (input.seriesName && hit.seriesNames.length) {
      const wantedSeries = normaliseName(input.seriesName);
      for (const name of hit.seriesNames) {
        seriesBoost = Math.max(seriesBoost, similarity(wantedSeries, normaliseName(name)));
      }
    }

    let score = wantedAuthors.length ? titleScore * 0.65 + authorScore * 0.25 + seriesBoost * 0.1 : titleScore;
    if (queryHadSeries && seriesBoost >= 0.9) score = Math.max(score, 0.72 + authorScore * 0.2);
    if (hit.compilation) score *= 0.85;
    return score;
  }

  private buildQueries(input: EnrichmentInput): Array<{ q: string; type: "Book" | "Series"; seriesAware: boolean }> {
    const queries: Array<{ q: string; type: "Book" | "Series"; seriesAware: boolean }> = [];
    const seen = new Set<string>();
    const push = (q: string, type: "Book" | "Series", seriesAware: boolean) => {
      const key = `${type}:${q.toLowerCase()}`;
      if (!q.trim() || seen.has(key)) return;
      seen.add(key);
      queries.push({ q: q.trim(), type, seriesAware });
    };

    const author = input.authors[0] ?? "";
    const seq = parseSequenceNumber(input.seriesSeq) ?? inferVolumeHint(input.title);
    const series = input.seriesName?.trim() ?? "";

    if (series && isMostlyLatin(series)) {
      push(series, "Series", true);
      push(author ? `${series} ${author}` : series, "Series", true);
      if (seq) {
        push(`${series} ${seq}`, "Book", true);
        push(`${series} volume ${seq}`, "Book", true);
        push(`${series} year ${seq}`, "Book", true);
      }
      push(author ? `${series} ${author}` : series, "Book", true);
    }

    for (const tag of input.tags ?? []) {
      if (isMostlyLatin(tag) && tag.length >= 4) {
        push(author ? `${tag} ${author}` : tag, "Book", false);
      }
    }

    // Ukrainian title last — often returns nothing useful, but keep as a last resort.
    push(author ? `${input.title} ${author}` : input.title, "Book", false);
    return queries;
  }

  private parseSeriesBooks(data: unknown): SeriesHit | null {
    const root = asRecord(data);
    const series = asRecord(root?.series_by_pk);
    if (!series) return null;
    const seriesId = firstString(series.id);
    const name = firstString(series.name);
    if (!seriesId || !name) return null;

    const books: SeriesBook[] = [];
    const rows = Array.isArray(series.book_series) ? series.book_series : [];
    for (const row of rows) {
      const entry = asRecord(row);
      const book = asRecord(entry?.book);
      if (!book) continue;
      const bookId = firstString(book.id);
      const title = firstString(book.title);
      if (!bookId || !title) continue;
      const ids = editionsIds(book.editions);
      const positionRaw = entry?.position;
      const position =
        typeof positionRaw === "number"
          ? positionRaw
          : typeof positionRaw === "string"
            ? Number.parseFloat(positionRaw)
            : null;
      books.push({
        bookId,
        slug: firstString(book.slug),
        title,
        authorNames: contributionsToNames(book.contributions),
        position: Number.isFinite(position) ? position : null,
        compilation: Boolean(entry?.compilation) || Boolean(book.compilation),
        coverUrl: extractCoverUrl(book),
        isbn: ids.isbn,
        asin: ids.asin,
        releaseYear: firstString(book.release_year),
      });
    }

    return {
      seriesId,
      slug: firstString(series.slug),
      name,
      books,
    };
  }

  private async loadSeries(seriesId: string): Promise<SeriesHit | null> {
    const id = Number.parseInt(seriesId, 10);
    if (!Number.isFinite(id)) return null;
    try {
      const data = await this.graphql(SERIES_BOOKS_QUERY, { id }, `series:${id}`);
      return this.parseSeriesBooks(data);
    } catch (error) {
      log.warn(`series ${seriesId} load failed: ${String(error)}`);
      return null;
    }
  }

  private async hydrateBook(bookId: string): Promise<SearchHit | null> {
    const id = Number.parseInt(bookId, 10);
    if (!Number.isFinite(id)) return null;
    try {
      const data = (await this.graphql(BOOK_BY_ID_QUERY, { id }, `book:${id}`)) as Record<string, unknown> | null;
      const book = asRecord(data?.books_by_pk);
      if (!book) return null;
      const ids = editionsIds(book.editions);
      return {
        bookId: firstString(book.id),
        slug: firstString(book.slug),
        title: firstString(book.title),
        authorNames: contributionsToNames(book.contributions),
        isbn: ids.isbn,
        asin: ids.asin,
        releaseYear: firstString(book.release_year),
        coverUrl: extractCoverUrl(book),
        seriesNames: [],
        compilation: Boolean(book.compilation),
        score: 1,
      };
    } catch (error) {
      log.warn(`book ${bookId} hydrate failed: ${String(error)}`);
      return null;
    }
  }

  private empty(): HardcoverEnrichment {
    return {
      bookId: null,
      slug: null,
      title: null,
      authorNames: [],
      isbn: null,
      asin: null,
      releaseYear: null,
      coverUrl: null,
      seriesId: null,
      seriesSlug: null,
      matchKind: "none",
      score: 0,
      compilation: false,
    };
  }

  private fromSeriesBook(
    series: SeriesHit,
    book: SeriesBook,
    kind: HardcoverMatchKind,
    score: number,
  ): HardcoverEnrichment {
    // volume-pack: keep id+slug so the UI/cover path can point at the Hardcover edition the
    // user found (e.g. all-the-young-dudes-volume-two) without collapsing ABS folders.
    const softLink = kind === "volume-pack";
    const coverOnly = kind === "series-cover" || (book.compilation && !softLink);
    return {
      bookId: coverOnly ? null : book.bookId,
      slug: coverOnly ? null : book.slug,
      title: book.title,
      authorNames: book.authorNames,
      isbn: book.compilation ? null : book.isbn,
      asin: book.compilation ? null : book.asin,
      releaseYear: book.releaseYear,
      coverUrl: book.coverUrl,
      seriesId: series.seriesId,
      seriesSlug: series.slug,
      matchKind: kind,
      score,
      compilation: book.compilation || softLink,
    };
  }

  private fromHit(hit: SearchHit, kind: HardcoverMatchKind, series?: SeriesHit | null): HardcoverEnrichment {
    const softLink = kind === "volume-pack";
    const coverOnly = (!softLink && hit.compilation) || kind === "series-cover";
    return {
      bookId: coverOnly ? null : hit.bookId,
      slug: coverOnly ? null : hit.slug,
      title: hit.title,
      authorNames: hit.authorNames,
      isbn: hit.compilation ? null : hit.isbn,
      asin: hit.compilation ? null : hit.asin,
      releaseYear: hit.releaseYear,
      coverUrl: hit.coverUrl,
      seriesId: series?.seriesId ?? null,
      seriesSlug: series?.slug ?? null,
      matchKind: hit.compilation && kind === "book" ? "volume-pack" : kind,
      score: hit.score,
      compilation: hit.compilation || softLink,
    };
  }

  /**
   * When Hardcover packs several years into one "Volume N" edition (e.g. Volume Two:
   * Years 5–7), keep each 4read listing as its own ABS item. Still attach the Hardcover
   * slug/cover when the year falls inside that pack.
   */
  private pickFromSeries(series: SeriesHit, input: EnrichmentInput): HardcoverEnrichment | null {
    if (series.books.length === 0) return null;
    const wanted = parseSequenceNumber(input.seriesSeq) ?? inferVolumeHint(input.title);
    const nonCompilations = series.books.filter((book) => !book.compilation);

    if (wanted !== null) {
      // 1:1 year/position match on a non-compilation edition.
      const exact = nonCompilations.find((book) => {
        const range = parseYearRange(book.title);
        if (range) return yearRangeContains(range, wanted) && range.from === range.to;
        return book.position !== null && Math.floor(book.position) === wanted;
      });
      if (exact) return this.fromSeriesBook(series, exact, "series-position", 0.92);

      // Packed volume whose title explicitly covers this year ("Years 5 - 7").
      const packed = series.books.find((book) => {
        const range = parseYearRange(book.title);
        return range !== null && yearRangeContains(range, wanted) && range.from !== range.to;
      });
      if (packed) return this.fromSeriesBook(series, packed, "volume-pack", 0.88);

      // Compilation flagged by Hardcover without a parseable year range — cover only,
      // and only if series position matches (weaker; volume# ≠ year# is common).
      const compilationAt = series.books.find(
        (book) =>
          book.compilation &&
          book.position !== null &&
          Math.floor(book.position) === wanted &&
          parseYearRange(book.title) === null,
      );
      if (compilationAt) {
        return this.fromSeriesBook(series, compilationAt, "series-cover", 0.65);
      }
    }

    // Series known but no safe year mapping — still expose a cover from the first real book.
    const coverDonor = nonCompilations[0] ?? series.books[0]!;
    return this.fromSeriesBook(series, coverDonor, "series-cover", 0.55);
  }

  /** Best Hardcover enrichment for a book, or an empty result when nothing scores well enough. */
  async enrich(input: EnrichmentInput): Promise<HardcoverEnrichment> {
    if (!this.enabled) return this.empty();
    if (Date.now() < this.disabledUntil) return this.empty();

    let seriesHit: SeriesHit | null = null;
    const bookHits: SearchHit[] = [];
    const seenBooks = new Set<string>();

    // Series-first when 4read already gives a Latin cycle name — avoids Ukrainian title noise
    // and usually needs only one or two API calls.
    for (const query of this.buildQueries(input).filter((entry) => entry.type === "Series")) {
      try {
        const results = await this.search(query.q, "Series");
        for (const document of extractHits(results)) {
          const id = firstString(document.id);
          const name = firstString(document.name ?? document.title);
          if (!id || !name) continue;
          if (input.seriesName && similarity(normaliseName(input.seriesName), normaliseName(name)) < 0.75) {
            continue;
          }
          seriesHit = await this.loadSeries(id);
          if (seriesHit) break;
        }
      } catch (error) {
        log.warn(`lookup failed for "${query.q}" (Series): ${String(error)}`);
      }
      if (seriesHit) break;
    }

    if (seriesHit) {
      const fromSeries = this.pickFromSeries(seriesHit, input);
      if (fromSeries && (fromSeries.matchKind === "series-position" || fromSeries.coverUrl)) {
        if (!fromSeries.coverUrl && fromSeries.bookId) {
          const hydrated = await this.hydrateBook(fromSeries.bookId);
          if (hydrated?.coverUrl) fromSeries.coverUrl = hydrated.coverUrl;
        } else if (!fromSeries.coverUrl) {
          const donorId =
            seriesHit.books.find((entry) => entry.coverUrl)?.bookId ?? seriesHit.books[0]?.bookId;
          if (donorId) {
            const hydrated = await this.hydrateBook(donorId);
            if (hydrated?.coverUrl) fromSeries.coverUrl = hydrated.coverUrl;
          }
        }
        // Confident year/position or packed-volume match: stop here.
        if (fromSeries.matchKind === "series-position" || fromSeries.matchKind === "volume-pack") {
          return fromSeries;
        }
        // Series known but no year mapping — cover from the series is still better than
        // burning the rate limit on Ukrainian title searches.
        if (fromSeries.matchKind === "series-cover") return fromSeries;
      }
    }

    for (const query of this.buildQueries(input).filter((entry) => entry.type === "Book")) {
      try {
        const results = await this.search(query.q, "Book");
        for (const document of extractHits(results)) {
          const hit = hitToSearch(document);
          if (!hit.bookId || seenBooks.has(hit.bookId)) continue;
          seenBooks.add(hit.bookId);
          hit.score = this.scoreHit(hit, input, query.seriesAware);
          bookHits.push(hit);
        }
      } catch (error) {
        log.warn(`lookup failed for "${query.q}" (Book): ${String(error)}`);
      }
      if (bookHits.some((hit) => hit.score >= 0.9 && !hit.compilation)) break;
    }

    bookHits.sort((a, b) => b.score - a.score);
    const best = bookHits[0];
    const accept = this.config.hardcover.acceptScore;
    const ambiguousLow = this.config.ai.minScore;
    const ambiguousHigh = this.config.ai.maxScore;

    if (best && best.score >= accept && !best.compilation) {
      const hydrated = best.coverUrl ? best : ((await this.hydrateBook(best.bookId!)) ?? best);
      hydrated.score = best.score;
      return this.fromHit(hydrated, "book", seriesHit);
    }

    if (
      best &&
      best.score >= ambiguousLow &&
      best.score < Math.max(accept, ambiguousHigh) &&
      this.ai.enabled
    ) {
      const decision = await this.ai.chooseMatch({
        title: input.title,
        authors: input.authors,
        seriesName: input.seriesName,
        seriesSeq: input.seriesSeq,
        candidates: bookHits.slice(0, 5).map((hit, index) => ({
          index,
          title: hit.title ?? "",
          authors: hit.authorNames,
          slug: hit.slug,
          compilation: hit.compilation,
        })),
      });
      if (decision && decision.index !== null && decision.confidence >= 0.7) {
        const chosen = bookHits[decision.index];
        if (chosen && !chosen.compilation) {
          const hydrated = chosen.coverUrl ? chosen : ((await this.hydrateBook(chosen.bookId!)) ?? chosen);
          hydrated.score = Math.max(chosen.score, decision.confidence);
          return this.fromHit(hydrated, "book", seriesHit);
        }
      }
    }

    if (seriesHit) {
      const fromSeries = this.pickFromSeries(seriesHit, input);
      if (fromSeries) {
        if (!fromSeries.coverUrl && fromSeries.bookId) {
          const hydrated = await this.hydrateBook(fromSeries.bookId);
          if (hydrated?.coverUrl) fromSeries.coverUrl = hydrated.coverUrl;
        }
        return fromSeries;
      }
    }

    if (best && best.score >= ambiguousLow) {
      const hydrated = best.coverUrl ? best : ((await this.hydrateBook(best.bookId!)) ?? best);
      hydrated.score = best.score;
      return this.fromHit(hydrated, "series-cover", seriesHit);
    }

    return this.empty();
  }

  /** @deprecated Prefer {@link enrich}; kept for older call sites / tests. */
  async lookup(title: string, authors: string[]): Promise<HardcoverEnrichment | null> {
    const result = await this.enrich({ title, authors, seriesName: null, seriesSeq: null });
    return result.matchKind === "none" ? null : result;
  }
}
