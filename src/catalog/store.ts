import { nowIso, type Db } from "../db.ts";
import type { ParsedBook } from "../source/book.ts";
import type { ListingCard } from "../source/listing.ts";
import type { IndexEntry } from "../source/indexes.ts";
import type { SitemapBookEntry } from "../source/sitemap.ts";
import { workIdentity } from "./normalize.ts";

export interface BookRow {
  source_id: number;
  url: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  cover_url: string | null;
  duration_sec: number | null;
  rating: number | null;
  votes: number | null;
  series_key: string | null;
  series_name: string | null;
  series_seq: string | null;
  published_year: string | null;
  lastmod: string | null;
  first_seen_at: string;
  fetched_at: string | null;
  content_hash: string | null;
  work_key: string | null;
  work_label: string | null;
  isbn: string | null;
  asin: string | null;
  hardcover_book_id: string | null;
  hardcover_slug: string | null;
  detail_state: string;
  detail_error: string | null;
}

export interface BookWithPeople extends BookRow {
  authors: string[];
  narrators: string[];
  genres: string[];
  tags: string[];
}

export function upsertAuthor(db: Db, entry: IndexEntry | { key: string; name: string; bookCount?: number | null }): void {
  db.query(
    `insert into authors (key, name, book_count) values (?, ?, ?)
     on conflict(key) do update set
       name = excluded.name,
       book_count = coalesce(excluded.book_count, authors.book_count)`,
  ).run(entry.key, entry.name, "bookCount" in entry ? (entry.bookCount ?? null) : null);
}

export function upsertNarrator(db: Db, entry: { key: string; name: string; bookCount?: number | null }): void {
  db.query(
    `insert into narrators (key, name, book_count) values (?, ?, ?)
     on conflict(key) do update set
       name = excluded.name,
       book_count = coalesce(excluded.book_count, narrators.book_count)`,
  ).run(entry.key, entry.name, entry.bookCount ?? null);
}

export function upsertSeries(db: Db, entry: { key: string; name: string; bookCount?: number | null }): void {
  db.query(
    `insert into series (key, name, book_count) values (?, ?, ?)
     on conflict(key) do update set
       name = excluded.name,
       book_count = coalesce(excluded.book_count, series.book_count)`,
  ).run(entry.key, entry.name, entry.bookCount ?? null);
}

export function upsertGenre(db: Db, entry: { key: string; name: string }): void {
  db.query(
    `insert into genres (key, name) values (?, ?)
     on conflict(key) do update set name = excluded.name`,
  ).run(entry.key, entry.name);
}

/**
 * Record a URL seen in the sitemap. Existing rows only get their `lastmod` bumped, and a
 * newer `lastmod` marks the detail page for a refetch.
 */
export function recordSitemapEntry(db: Db, entry: SitemapBookEntry): "new" | "stale" | "unchanged" {
  const existing = db
    .query<{ lastmod: string | null; fetched_at: string | null; detail_state: string }, [number]>(
      "select lastmod, fetched_at, detail_state from books where source_id = ?",
    )
    .get(entry.sourceId);

  if (!existing) {
    db.query(
      `insert into books (source_id, url, slug, title, lastmod, first_seen_at, detail_state)
       values (?, ?, ?, '', ?, ?, 'pending')`,
    ).run(entry.sourceId, entry.loc, entry.slug, entry.lastmod, nowIso());
    return "new";
  }

  const isNewer = entry.lastmod !== null && (existing.lastmod === null || entry.lastmod > existing.lastmod);
  const neverFetched = existing.fetched_at === null;

  if (isNewer || (neverFetched && existing.detail_state === "ok")) {
    db.query(
      "update books set url = ?, slug = ?, lastmod = ?, detail_state = 'pending' where source_id = ?",
    ).run(entry.loc, entry.slug, entry.lastmod, entry.sourceId);
    return "stale";
  }

  db.query("update books set url = ?, slug = ? where source_id = ?").run(entry.loc, entry.slug, entry.sourceId);
  return "unchanged";
}

/** Which xfsearch facet a listing card was discovered on, if any. */
export interface ListingFacet {
  kind: "avtor" | "chitaet" | "cikl";
  key: string;
  /** Display name for the entity table; defaults to the key. */
  name?: string;
}

/**
 * Cheap partial record from a listing card. Never downgrades a fully fetched row: only
 * fields the detail parser also produces are filled, and only when still empty.
 * When `facet` is set (author / narrator / series listing), the book is linked to that
 * entity immediately so subscriptions can match before a detail page is fetched.
 */
export function recordListingCard(db: Db, card: ListingCard, facet?: ListingFacet): void {
  const existing = db
    .query<{ source_id: number; detail_state: string }, [number]>(
      "select source_id, detail_state from books where source_id = ?",
    )
    .get(card.sourceId);

  if (!existing) {
    db.query(
      `insert into books (source_id, url, slug, title, cover_url, duration_sec, rating, votes, first_seen_at, detail_state)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      card.sourceId,
      card.url,
      card.slug,
      card.title,
      card.coverUrl,
      card.durationSec,
      card.rating,
      card.votes,
      nowIso(),
    );
  } else {
    db.query(
      `update books set
         url = ?,
         slug = ?,
         title = case when title = '' then ? else title end,
         cover_url = coalesce(cover_url, ?),
         duration_sec = coalesce(duration_sec, ?),
         rating = coalesce(?, rating),
         votes = coalesce(?, votes)
       where source_id = ?`,
    ).run(
      card.url,
      card.slug,
      card.title,
      card.coverUrl,
      card.durationSec,
      card.rating,
      card.votes,
      card.sourceId,
    );
  }

  if (facet) attachListingFacet(db, card.sourceId, facet);
}

function attachListingFacet(db: Db, sourceId: number, facet: ListingFacet): void {
  const name = (facet.name ?? facet.key).trim() || facet.key;
  if (facet.kind === "avtor") {
    upsertAuthor(db, { key: facet.key, name });
    db.query("insert or ignore into book_authors (source_id, author_key) values (?, ?)").run(sourceId, facet.key);
    return;
  }
  if (facet.kind === "chitaet") {
    upsertNarrator(db, { key: facet.key, name });
    db.query("insert or ignore into book_narrators (source_id, narrator_key) values (?, ?)").run(sourceId, facet.key);
    return;
  }
  upsertSeries(db, { key: facet.key, name });
  db.query(
    `update books set
       series_key = coalesce(series_key, ?),
       series_name = coalesce(series_name, ?)
     where source_id = ?`,
  ).run(facet.key, name, sourceId);
}

export function recordBookDetail(db: Db, book: ParsedBook, options: { lastmod?: string | null } = {}): void {
  const identity = workIdentity(
    book.authors.map((author) => author.name),
    book.title,
  );
  const contentHash = Bun.hash(
    JSON.stringify([
      book.title,
      book.description,
      book.coverUrl,
      book.durationSec,
      book.authors.map((a) => a.key),
      book.narrators.map((n) => n.key),
      book.genres.map((g) => g.key),
      book.series?.key ?? null,
      book.series?.sequence ?? null,
      book.tags,
    ]),
  ).toString(16);

  const transaction = db.transaction(() => {
    db.query(
      `insert into books (
         source_id, url, slug, title, description, cover_url, duration_sec, rating, votes,
         series_key, series_name, series_seq, lastmod, first_seen_at, fetched_at, content_hash,
         work_key, work_label, detail_state, detail_error
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', null)
       on conflict(source_id) do update set
         url = excluded.url,
         slug = excluded.slug,
         title = excluded.title,
         description = excluded.description,
         cover_url = excluded.cover_url,
         duration_sec = excluded.duration_sec,
         rating = excluded.rating,
         votes = excluded.votes,
         series_key = excluded.series_key,
         series_name = excluded.series_name,
         series_seq = excluded.series_seq,
         lastmod = coalesce(excluded.lastmod, books.lastmod),
         fetched_at = excluded.fetched_at,
         content_hash = excluded.content_hash,
         work_key = excluded.work_key,
         work_label = excluded.work_label,
         detail_state = 'ok',
         detail_error = null`,
    ).run(
      book.sourceId,
      book.url,
      book.slug,
      book.title,
      book.description,
      book.coverUrl,
      book.durationSec,
      book.rating,
      book.votes,
      book.series?.key ?? null,
      book.series?.name ?? null,
      book.series?.sequence ?? null,
      options.lastmod ?? null,
      nowIso(),
      nowIso(),
      contentHash,
      identity.key,
      identity.label,
    );

    for (const author of book.authors) upsertAuthor(db, author);
    for (const narrator of book.narrators) upsertNarrator(db, narrator);
    for (const genre of book.genres) upsertGenre(db, genre);
    if (book.series) upsertSeries(db, book.series);

    db.query("delete from book_authors where source_id = ?").run(book.sourceId);
    db.query("delete from book_narrators where source_id = ?").run(book.sourceId);
    db.query("delete from book_genres where source_id = ?").run(book.sourceId);
    db.query("delete from book_tags where source_id = ?").run(book.sourceId);

    for (const author of book.authors) {
      db.query("insert or ignore into book_authors (source_id, author_key) values (?, ?)").run(
        book.sourceId,
        author.key,
      );
    }
    for (const narrator of book.narrators) {
      db.query("insert or ignore into book_narrators (source_id, narrator_key) values (?, ?)").run(
        book.sourceId,
        narrator.key,
      );
    }
    for (const genre of book.genres) {
      db.query("insert or ignore into book_genres (source_id, genre_key) values (?, ?)").run(
        book.sourceId,
        genre.key,
      );
    }
    for (const tag of book.tags) {
      db.query("insert or ignore into book_tags (source_id, tag) values (?, ?)").run(book.sourceId, tag);
    }
  });

  transaction();
}

export function markBookState(db: Db, sourceId: number, state: "pending" | "ok" | "error" | "skipped", error?: string): void {
  db.query("update books set detail_state = ?, detail_error = ?, fetched_at = ? where source_id = ?").run(
    state,
    error ?? null,
    nowIso(),
    sourceId,
  );
}

export function getBook(db: Db, sourceId: number): BookWithPeople | null {
  const row = db.query<BookRow, [number]>("select * from books where source_id = ?").get(sourceId);
  return row ? withPeople(db, row) : null;
}

export function withPeople(db: Db, row: BookRow): BookWithPeople {
  const names = (table: string, column: string, source: string) =>
    db
      .query<{ name: string }, [number]>(
        `select s.name as name from ${table} b join ${source} s on s.key = b.${column} where b.source_id = ? order by s.name`,
      )
      .all(row.source_id)
      .map((entry) => entry.name);

  return {
    ...row,
    authors: names("book_authors", "author_key", "authors"),
    narrators: names("book_narrators", "narrator_key", "narrators"),
    genres: names("book_genres", "genre_key", "genres"),
    tags: db
      .query<{ tag: string }, [number]>("select tag from book_tags where source_id = ? order by tag")
      .all(row.source_id)
      .map((entry) => entry.tag),
  };
}

export function booksNeedingDetail(db: Db, limit: number): BookRow[] {
  return db
    .query<BookRow, [number]>(
      `select * from books
       where detail_state = 'pending'
       order by (fetched_at is not null), coalesce(lastmod, '') desc, source_id desc
       limit ?`,
    )
    .all(limit);
}

/**
 * Pending detail pages for books that already match a subscription or sit in the news
 * queue. Used when the catalogue-wide backfill is off so we do not spend FlareSolverr
 * budget on unrelated sitemap entries.
 */
export function booksNeedingDetailForSubscriptions(
  db: Db,
  subscriptions: Array<{ type: string; value: string; enabled?: boolean }>,
  limit: number,
): BookRow[] {
  const ids = new Set<number>();
  for (const subscription of subscriptions) {
    if (subscription.enabled === false) continue;
    for (const book of booksForSubscription(db, subscription.type, subscription.value)) {
      if (book.detail_state === "pending") ids.add(book.source_id);
    }
  }
  for (const row of db
    .query<{ source_id: number }, []>(
      `select q.source_id from queue q
       join books b on b.source_id = q.source_id
       where b.detail_state = 'pending'`,
    )
    .all()) {
    ids.add(row.source_id);
  }
  if (ids.size === 0) return [];

  const placeholders = [...ids].map(() => "?").join(",");
  return db
    .query<BookRow, number[]>(
      `select * from books
       where source_id in (${placeholders}) and detail_state = 'pending'
       order by (fetched_at is not null), coalesce(lastmod, '') desc, source_id desc
       limit ?`,
    )
    .all(...ids, limit);
}

const SUBSCRIPTION_QUERIES: Record<string, string> = {
  author: `select b.* from books b
           join book_authors ba on ba.source_id = b.source_id
           join authors a on a.key = ba.author_key
           where ba.author_key = ?1 or lower(a.name) = ?1`,
  narrator: `select b.* from books b
             join book_narrators bn on bn.source_id = b.source_id
             join narrators n on n.key = bn.narrator_key
             where bn.narrator_key = ?1 or lower(n.name) = ?1`,
  series: `select b.* from books b
           left join series s on s.key = b.series_key
           where b.series_key = ?1 or lower(s.name) = ?1`,
  genre: `select b.* from books b
          join book_genres bg on bg.source_id = b.source_id
          join genres g on g.key = bg.genre_key
          where bg.genre_key = ?1 or lower(g.name) = ?1`,
  tag: `select b.* from books b
        join book_tags bt on bt.source_id = b.source_id
        where lower(bt.tag) = ?1`,
};

export function booksForSubscription(db: Db, type: string, value: string): BookWithPeople[] {
  const sql = SUBSCRIPTION_QUERIES[type];
  if (!sql) return [];
  const needle = value.trim().toLowerCase();
  const rows = db.query<BookRow, [string]>(sql).all(needle);
  return rows.map((row) => withPeople(db, row));
}

export interface CatalogCounts {
  books: number;
  booksDetailed: number;
  booksPending: number;
  authors: number;
  narrators: number;
  series: number;
  genres: number;
}

export function catalogCounts(db: Db): CatalogCounts {
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    books: count("select count(*) as n from books"),
    booksDetailed: count("select count(*) as n from books where detail_state = 'ok'"),
    booksPending: count("select count(*) as n from books where detail_state = 'pending'"),
    authors: count("select count(*) as n from authors"),
    narrators: count("select count(*) as n from narrators"),
    series: count("select count(*) as n from series"),
    genres: count("select count(*) as n from genres"),
  };
}
