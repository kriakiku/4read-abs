import type { AppContext } from "../context.ts";
import { nowIso } from "../db.ts";
import { logger } from "../log.ts";
import { groupByWork, type WorkGroup } from "../catalog/select.ts";
import { booksForSubscription, getBook, type BookWithPeople } from "../catalog/store.ts";
import { coverProxyUrl } from "../covers.ts";
import { getLinkBySource, removeLinkBySource } from "../abs/matcher.ts";
import { stagingDirFor } from "../abs/stage.ts";
import { clearBookFolder } from "../audio/m3u.ts";
import { crawlFacet } from "./crawl.ts";

const log = logger("subs");

export interface QueueRow {
  id: number;
  source_id: number;
  reason: string;
  state: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueEntry extends QueueRow {
  book: BookWithPeople | null;
  linkedItemId: string | null;
  /** Local cover URL with a version query so browsers do not keep a stale image. */
  coverUrl: string | null;
}

export interface RefreshResult {
  subscriptions: number;
  matched: number;
  queued: number;
  deduped: number;
  alreadyLinked: number;
  alreadyQueued: number;
}

/**
 * Re-evaluate every subscription against the catalogue.
 *
 * Duplicate readings of the same book collapse to a single entry, chosen by narrator
 * preference; books already present in Audiobookshelf are not queued as news because the sync
 * job keeps their metadata current instead.
 */
export async function refreshQueue(ctx: AppContext, options: { crawlFacets?: boolean } = {}): Promise<RefreshResult> {
  const enabled = ctx.config.subscriptions.filter((subscription) => subscription.enabled);
  const result: RefreshResult = {
    subscriptions: enabled.length,
    matched: 0,
    queued: 0,
    deduped: 0,
    alreadyLinked: 0,
    alreadyQueued: 0,
  };

  // Pulling the facet listing first makes sure newly published volumes are known even when
  // the sitemap has not been re-read yet.
  if (options.crawlFacets) {
    for (const subscription of enabled) {
      const kind =
        subscription.type === "author" ? "avtor" : subscription.type === "narrator" ? "chitaet" : subscription.type === "series" ? "cikl" : null;
      if (!kind) continue;
      try {
        await crawlFacet(ctx, kind, subscription.value.trim().toLowerCase(), 2, subscription.value);
      } catch (error) {
        log.warn(`facet crawl failed for ${subscription.type}:${subscription.value}: ${String(error)}`);
      }
    }
  }

  const reasonsBySource = new Map<number, Set<string>>();
  const booksById = new Map<number, BookWithPeople>();
  const groupsBySubscription: Array<{ reason: string; groups: WorkGroup[] }> = [];

  for (const subscription of enabled) {
    const books = booksForSubscription(ctx.db, subscription.type, subscription.value);
    result.matched += books.length;
    const groups = groupByWork(books, ctx.config);
    result.deduped += books.length - groups.length;
    groupsBySubscription.push({ reason: `${subscription.type}:${subscription.value}`, groups });
  }

  for (const { reason, groups } of groupsBySubscription) {
    for (const group of groups) {
      const book = group.best.book;
      if (group.best.blocked) continue;
      booksById.set(book.source_id, book);
      const reasons = reasonsBySource.get(book.source_id) ?? new Set<string>();
      reasons.add(reason);
      reasonsBySource.set(book.source_id, reasons);
    }
  }

  const insert = ctx.db.transaction(() => {
    for (const [sourceId, reasons] of reasonsBySource) {
      const reason = [...reasons].sort().join(", ");
      const link = getLinkBySource(ctx.db, sourceId);
      const existing = ctx.db
        .query<QueueRow, [number]>("select * from queue where source_id = ?")
        .get(sourceId);

      if (link) {
        result.alreadyLinked += 1;
        // Present in the library already: keep the record but do not surface it as news.
        if (existing && existing.state === "new") {
          ctx.db
            .query("update queue set state = 'synced', reason = ?, updated_at = ? where source_id = ?")
            .run(reason, nowIso(), sourceId);
        }
        continue;
      }

      if (existing) {
        result.alreadyQueued += 1;
        ctx.db.query("update queue set reason = ?, updated_at = ? where source_id = ?").run(reason, nowIso(), sourceId);
        continue;
      }

      ctx.db
        .query(
          "insert into queue (source_id, reason, state, created_at, updated_at) values (?, ?, 'new', ?, ?)",
        )
        .run(sourceId, reason, nowIso(), nowIso());
      result.queued += 1;
    }
  });
  insert();

  log.info(
    `subscriptions: ${result.subscriptions}, matched ${result.matched}, deduped ${result.deduped}, queued ${result.queued}, alreadyQueued ${result.alreadyQueued}, alreadyLinked ${result.alreadyLinked}`,
  );
  return result;
}

export async function listQueue(ctx: AppContext, state?: string, limit = 200): Promise<QueueEntry[]> {
  const rows = state
    ? ctx.db
        .query<QueueRow, [string, number]>(
          "select * from queue where state = ? order by datetime(created_at) desc limit ?",
        )
        .all(state, limit)
    : ctx.db
        .query<QueueRow, [number]>("select * from queue order by datetime(created_at) desc limit ?")
        .all(limit);

  return Promise.all(
    rows.map(async (row) => {
      const book = getBook(ctx.db, row.source_id);
      const link = getLinkBySource(ctx.db, row.source_id);
      return {
        ...row,
        book,
        linkedItemId: link?.abs_item_id ?? null,
        coverUrl: book ? await coverProxyUrl(book, ctx.config) : null,
      };
    }),
  );
}

export function setQueueState(ctx: AppContext, sourceId: number, state: string, note?: string): void {
  ctx.db
    .query("update queue set state = ?, note = coalesce(?, note), updated_at = ? where source_id = ?")
    .run(state, note ?? null, nowIso(), sourceId);
}

/**
 * Remove a queue entry so "Check subscriptions" can enqueue it again, and wipe local
 * staging / prepared folders (audio, cover preview, metadata) so Accept starts clean.
 * Catalogue description stays in the DB — that is shared book data, not queue state.
 */
export async function deleteQueueEntry(
  ctx: AppContext,
  sourceId: number,
): Promise<{ ok: boolean; clearedAudio: number; wipedStaging: boolean }> {
  const existing = ctx.db
    .query<QueueRow, [number]>("select * from queue where source_id = ?")
    .get(sourceId);

  ctx.db.query("delete from queue where source_id = ?").run(sourceId);
  removeLinkBySource(ctx.db, sourceId);

  let clearedAudio = 0;
  let wipedStaging = false;
  const book = getBook(ctx.db, sourceId);
  if (book) {
    const staging = await clearBookFolder(stagingDirFor(book, ctx.config));
    clearedAudio += staging.audio;
    wipedStaging = staging.wiped;
  }
  const preparedDir = existing?.note?.trim();
  if (preparedDir) {
    const prepared = await clearBookFolder(preparedDir);
    clearedAudio += prepared.audio;
  }

  log.info(
    `deleted queue entry ${sourceId} (cleared ${clearedAudio} audio file(s), wipedStaging=${wipedStaging})`,
  );
  return { ok: true, clearedAudio, wipedStaging };
}

export function queueCounts(ctx: AppContext): Record<string, number> {
  const rows = ctx.db
    .query<{ state: string; n: number }, []>("select state, count(*) as n from queue group by state")
    .all();
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = row.n;
  return counts;
}
