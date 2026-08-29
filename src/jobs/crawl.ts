import type { AppContext } from "../context.ts";
import { logger } from "../log.ts";
import { getMeta, setMeta } from "../db.ts";
import { parseBookPage } from "../source/book.ts";
import { parseEntityIndex } from "../source/indexes.ts";
import { parseListingPage } from "../source/listing.ts";
import { parseBookSitemap, parseSitemapIndex, isArticleSitemapUrl, sitemapIndexUrl } from "../source/sitemap.ts";
import { bookUrl, xfsearchUrl } from "../source/urls.ts";
import {
  booksNeedingDetail,
  booksNeedingDetailForSubscriptions,
  markBookState,
  recordBookDetail,
  recordListingCard,
  recordSitemapEntry,
  upsertAuthor,
  upsertNarrator,
} from "../catalog/store.ts";
import { CooldownError } from "../fetch/fetcher.ts";

const log = logger("crawl");

export interface SeedResult {
  authors: number;
  narrators: number;
}

/**
 * Populate authors and narrators from the site's two index pages. Two requests give the whole
 * entity space, so subscriptions can be configured long before the detail backfill finishes.
 */
export async function seedEntities(ctx: AppContext): Promise<SeedResult> {
  const base = ctx.config.source.baseUrl;
  const result: SeedResult = { authors: 0, narrators: 0 };

  const authorsPage = await ctx.fetcher.getText(`${base}/avtors.html`);
  for (const entry of parseEntityIndex(authorsPage.body, "avtor", base)) {
    upsertAuthor(ctx.db, entry);
    result.authors += 1;
  }

  const readersPage = await ctx.fetcher.getText(`${base}/readers.html`);
  for (const entry of parseEntityIndex(readersPage.body, "chitaet", base)) {
    upsertNarrator(ctx.db, entry);
    result.narrators += 1;
  }

  setMeta(ctx.db, "seeded_at", new Date().toISOString());
  log.info(`seeded ${result.authors} authors and ${result.narrators} narrators`);
  return result;
}

export interface SitemapResult {
  total: number;
  added: number;
  stale: number;
}

/**
 * Walk the sitemap and reconcile it with the local catalogue. Every entry carries a `lastmod`,
 * so only genuinely changed pages get queued for a refetch.
 */
export async function syncSitemap(ctx: AppContext): Promise<SitemapResult> {
  const base = ctx.config.source.baseUrl;
  const indexUrl = sitemapIndexUrl(base);
  log.info(`fetching sitemap index ${indexUrl}`);
  const index = await ctx.fetcher.getText(indexUrl);
  const children = parseSitemapIndex(index.body).filter(isArticleSitemapUrl);
  const targets = children.length > 0 ? children : [`${base}/news_pages.xml`];
  log.info(`sitemap index → ${targets.length} article sitemap(s): ${targets.join(", ")}`);

  const result: SitemapResult = { total: 0, added: 0, stale: 0 };

  for (const target of targets) {
    log.info(`fetching article sitemap ${target}`);
    const page = await ctx.fetcher.getText(target);
    log.info(`parsed ${target} (${page.body.length} bytes, via ${page.strategy})`);
    const entries = parseBookSitemap(page.body, base);
    const apply = ctx.db.transaction(() => {
      for (const entry of entries) {
        const outcome = recordSitemapEntry(ctx.db, entry);
        result.total += 1;
        if (outcome === "new") result.added += 1;
        if (outcome === "stale") result.stale += 1;
      }
    });
    apply();
  }

  setMeta(ctx.db, "sitemap_synced_at", new Date().toISOString());
  log.info(`sitemap: ${result.total} entries, ${result.added} new, ${result.stale} changed`);
  return result;
}

/** Fetch and store one book detail page. Blog posts share the URL shape and are marked skipped. */
export async function fetchBookDetail(ctx: AppContext, sourceId: number, url?: string): Promise<"ok" | "skipped"> {
  const row = ctx.db
    .query<{ url: string; slug: string; lastmod: string | null }, [number]>(
      "select url, slug, lastmod from books where source_id = ?",
    )
    .get(sourceId);
  const target = url ?? row?.url ?? bookUrl(sourceId, row?.slug ?? "", ctx.config.source.baseUrl);

  const page = await ctx.fetcher.getText(target);
  const parsed = parseBookPage(page.body, target, ctx.config.source.baseUrl);

  if (!parsed) {
    markBookState(ctx.db, sourceId, "skipped", "not a book page");
    return "skipped";
  }

  recordBookDetail(ctx.db, parsed, { lastmod: row?.lastmod ?? null });

  // Sibling volumes linked from the description are usually not discoverable any other way
  // until the sitemap catches up, so register them as pending.
  for (const relatedId of parsed.relatedBookIds) {
    const known = ctx.db
      .query<{ source_id: number }, [number]>("select source_id from books where source_id = ?")
      .get(relatedId);
    if (!known) {
      ctx.db
        .query(
          `insert into books (source_id, url, slug, title, first_seen_at, detail_state)
           values (?, ?, '', '', ?, 'pending')`,
        )
        .run(relatedId, bookUrl(relatedId, "", ctx.config.source.baseUrl), new Date().toISOString());
    }
  }

  await enrichWithHardcover(ctx, sourceId);
  return "ok";
}

async function enrichWithHardcover(ctx: AppContext, sourceId: number): Promise<void> {
  if (!ctx.hardcover.enabled) return;
  const row = ctx.db
    .query<
      {
        title: string;
        series_name: string | null;
        series_seq: string | null;
        hardcover_book_id: string | null;
        hardcover_cover_url: string | null;
      },
      [number]
    >(
      "select title, series_name, series_seq, hardcover_book_id, hardcover_cover_url from books where source_id = ?",
    )
    .get(sourceId);
  // Skip only when we already have both a book id and a cover; otherwise retry for covers.
  if (!row || (row.hardcover_book_id && row.hardcover_cover_url)) return;

  const authors = ctx.db
    .query<{ name: string }, [number]>(
      "select a.name from book_authors ba join authors a on a.key = ba.author_key where ba.source_id = ?",
    )
    .all(sourceId)
    .map((entry) => entry.name);

  const tags = ctx.db
    .query<{ tag: string }, [number]>("select tag from book_tags where source_id = ?")
    .all(sourceId)
    .map((entry) => entry.tag);

  const match = await ctx.hardcover.enrich({
    title: row.title,
    authors,
    seriesName: row.series_name,
    seriesSeq: row.series_seq,
    tags,
  });
  if (match.matchKind === "none" && !match.coverUrl) return;

  ctx.db
    .query(
      `update books set
         hardcover_book_id = coalesce(?, hardcover_book_id),
         hardcover_slug = coalesce(?, hardcover_slug),
         hardcover_cover_url = coalesce(?, hardcover_cover_url),
         hardcover_series_id = coalesce(?, hardcover_series_id),
         hardcover_match_kind = coalesce(?, hardcover_match_kind),
         isbn = coalesce(isbn, ?),
         asin = coalesce(asin, ?),
         published_year = coalesce(published_year, ?)
       where source_id = ?`,
    )
    .run(
      match.bookId,
      match.slug,
      match.coverUrl,
      match.seriesId,
      match.matchKind === "none" ? null : match.matchKind,
      match.isbn,
      match.asin,
      match.releaseYear,
      sourceId,
    );
  log.debug(
    `hardcover ${match.matchKind} for ${sourceId}: ${match.slug ?? match.seriesSlug ?? match.bookId ?? "cover-only"} (${match.score.toFixed(2)})`,
  );
}

export interface BackfillResult {
  attempted: number;
  ok: number;
  skipped: number;
  failed: number;
  stoppedEarly: boolean;
}

/**
 * Slowly work through books whose detail page has never been read. Stops as soon as the
 * source starts pushing back so a backfill never turns into a hammering loop.
 *
 * By default only subscription matches and queued books are fetched (see
 * `schedule.backfillAll`). The sitemap still registers the whole catalogue; it just does
 * not spend FlareSolverr budget on unrelated detail pages.
 */
export async function backfillDetails(ctx: AppContext, limit: number): Promise<BackfillResult> {
  const result: BackfillResult = { attempted: 0, ok: 0, skipped: 0, failed: 0, stoppedEarly: false };
  const pending = ctx.config.schedule.backfillAll
    ? booksNeedingDetail(ctx.db, limit)
    : booksNeedingDetailForSubscriptions(ctx.db, ctx.config.subscriptions, limit);

  for (const book of pending) {
    if (ctx.fetcher.limiter.inCooldown() && !ctx.fetcher.flareConfigured) {
      result.stoppedEarly = true;
      break;
    }
    result.attempted += 1;
    try {
      const outcome = await fetchBookDetail(ctx, book.source_id, book.url);
      if (outcome === "ok") result.ok += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      markBookState(ctx.db, book.source_id, "pending", String(error));
      if (error instanceof CooldownError) {
        result.stoppedEarly = true;
        break;
      }
      log.warn(`detail fetch failed for ${book.source_id}: ${String(error)}`);
      // Three consecutive failures usually means the source is blocking us again.
      if (result.failed >= 3 && result.ok === 0) {
        result.stoppedEarly = true;
        break;
      }
    }
  }

  setMeta(ctx.db, "backfill_ran_at", new Date().toISOString());
  return result;
}

/**
 * Walk a facet listing (a series, narrator or author page) and register every book on it.
 * One request covers up to ~24 books, which is far cheaper than visiting each detail page,
 * and it is how a subscription discovers volumes the sitemap has not surfaced yet.
 * Books are linked to the facet immediately so the queue can fill without a detail crawl.
 */
export async function crawlFacet(
  ctx: AppContext,
  kind: "avtor" | "chitaet" | "cikl",
  key: string,
  maxPages = 5,
  displayName?: string,
): Promise<{ pages: number; cards: number }> {
  const base = ctx.config.source.baseUrl;
  const facetKey = key.trim().toLowerCase();
  let pages = 0;
  let cards = 0;
  let lastPage = 1;

  for (let page = 1; page <= Math.min(maxPages, lastPage); page += 1) {
    const url = xfsearchUrl(kind, facetKey, page, base);
    const response = await ctx.fetcher.getText(url);
    const listing = parseListingPage(response.body, base);
    lastPage = Math.max(lastPage, listing.lastPage);
    pages += 1;

    const apply = ctx.db.transaction(() => {
      for (const card of listing.cards) {
        recordListingCard(ctx.db, card, {
          kind,
          key: facetKey,
          name: displayName?.trim() || facetKey,
        });
        cards += 1;
      }
    });
    apply();

    if (listing.cards.length === 0) break;
  }

  return { pages, cards };
}

export function lastSitemapSync(ctx: AppContext): string | null {
  return getMeta(ctx.db, "sitemap_synced_at");
}
