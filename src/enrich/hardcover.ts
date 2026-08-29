import type { Config } from "../config.ts";
import { nowIso, type Db } from "../db.ts";
import { logger } from "../log.ts";
import { normaliseName, similarity, normaliseTitle } from "../catalog/normalize.ts";

const log = logger("hardcover");

export interface HardcoverMatch {
  bookId: string | null;
  slug: string | null;
  title: string | null;
  authorNames: string[];
  isbn: string | null;
  asin: string | null;
  releaseYear: string | null;
  score: number;
}

const SEARCH_QUERY = /* graphql */ `
  query Search($q: String!) {
    search(query: $q, query_type: "Book", per_page: 10, page: 1) {
      results
    }
  }
`;

interface GraphQlResponse {
  data?: { search?: { results?: unknown } };
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
  return null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => firstString(entry)).filter((entry): entry is string => !!entry);
  const single = firstString(value);
  return single ? [single] : [];
}

/**
 * The search payload is a passthrough of Hardcover's search index and its shape is not
 * guaranteed by the beta API, so hits are read defensively rather than against a fixed type.
 */
function extractHits(results: unknown): Array<Record<string, unknown>> {
  const root = asRecord(results);
  if (!root) return [];
  const hits = root.hits;
  if (!Array.isArray(hits)) return [];
  const documents: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    const record = asRecord(hit);
    if (!record) continue;
    const document = asRecord(record.document) ?? record;
    documents.push(document);
  }
  return documents;
}

function toMatch(document: Record<string, unknown>): HardcoverMatch {
  return {
    bookId: firstString(document.id),
    slug: firstString(document.slug),
    title: firstString(document.title),
    authorNames: stringArray(document.author_names ?? document.authors ?? document.contributions),
    isbn: firstString(document.isbns ?? document.isbn ?? document.isbn_13 ?? document.isbn13),
    asin: firstString(document.asin ?? document.asins),
    releaseYear: firstString(document.release_year ?? document.publication_year),
    score: 0,
  };
}

/**
 * Optional enrichment that maps a source book onto Hardcover's canonical ids. Coverage for
 * Ukrainian editions is patchy, so every failure is soft: the caller keeps its own keys.
 */
export class HardcoverClient {
  private nextAllowedAt = 0;
  private disabledUntil = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

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
    // Free tier allows a burst of 10 and 60/minute; one request per second stays well inside.
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.nextAllowedAt = Date.now() + 1100;
  }

  private async query(variables: { q: string }): Promise<unknown> {
    await this.pace();
    const response = await fetch(this.config.hardcover.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.config.hardcover.apiKey,
        "user-agent": "4read-abs (audiobook metadata sync)",
      },
      body: JSON.stringify({ query: SEARCH_QUERY, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
      this.disabledUntil = Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000;
      throw new Error(`rate limited, backing off ${retryAfter}s`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GraphQlResponse;
    if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
    if (payload.error) throw new Error(payload.error);
    return payload.data?.search?.results;
  }

  /** Best Hardcover match for a book, or null when nothing scores well enough. */
  async lookup(title: string, authors: string[]): Promise<HardcoverMatch | null> {
    if (!this.enabled) return null;
    if (Date.now() < this.disabledUntil) return null;

    const q = [title, authors[0] ?? ""].filter(Boolean).join(" ").trim();
    if (!q) return null;

    const cacheKey = `search:${q.toLowerCase()}`;
    let results = this.cacheGet(cacheKey);

    if (results === undefined) {
      try {
        results = await this.query({ q });
        this.cacheSet(cacheKey, results ?? null);
      } catch (error) {
        log.warn(`lookup failed for "${q}": ${String(error)}`);
        return null;
      }
    }

    const wantedTitle = normaliseTitle(title);
    const wantedAuthors = authors.map((name) => normaliseName(name));

    const scored = extractHits(results)
      .map(toMatch)
      .map((match) => {
        const titleScore = match.title ? similarity(wantedTitle, normaliseTitle(match.title)) : 0;
        let authorScore = 0;
        if (wantedAuthors.length && match.authorNames.length) {
          for (const one of wantedAuthors) {
            for (const other of match.authorNames) {
              authorScore = Math.max(authorScore, similarity(one, normaliseName(other)));
            }
          }
        }
        return { ...match, score: wantedAuthors.length ? titleScore * 0.7 + authorScore * 0.3 : titleScore };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    // Ukrainian titles rarely match Hardcover's English records, so require real confidence.
    if (!best || best.score < 0.8) return null;
    return best;
  }
}
