import { resolve } from "node:path";
import type { AppContext } from "../context.ts";
import { logger } from "../log.ts";
import { cachedCover, downloadCoverIfStale, type DownloadedCover } from "../covers.ts";
import { setMeta } from "../db.ts";
import { getBook, type BookWithPeople } from "../catalog/store.ts";
import {
  getLinkBySource,
  matchItem,
  previousPayload,
  recordWrite,
  saveLink,
  type MatchOutcome,
} from "../abs/matcher.ts";
import {
  buildSidecar,
  itemToSidecar,
  reconcileSidecar,
  sidecarHash,
  type Sidecar,
} from "../abs/metadata.ts";
import { mapAbsPathToLocal } from "../abs/pathmap.ts";
import { placeIntoLibrary, stageBook, targetFolderFor } from "../abs/stage.ts";
import type { AbsItem } from "../abs/client.ts";
import { setQueueState } from "./subscriptions.ts";

const log = logger("sync");

/** Never let a blocked cover stop the metadata write; the sidecar still goes out. */
async function ensureCover(ctx: AppContext, book: BookWithPeople): Promise<DownloadedCover | null> {
  try {
    return await downloadCoverIfStale(ctx.fetcher, book, ctx.config);
  } catch (error) {
    log.warn(`cover download failed for ${book.source_id}: ${String(error)}`);
    return null;
  }
}

export interface ItemSyncOutcome {
  sourceId: number;
  itemId: string;
  title: string;
  changedFields: string[];
  skippedFields: string[];
  wrote: boolean;
  scanned: boolean;
  error?: string;
}

export interface SyncResult {
  libraries: number;
  items: number;
  matched: number;
  unmatched: number;
  written: number;
  created: number;
  errors: string[];
  outcomes: ItemSyncOutcome[];
}

/** Where this process can write for a library item that Audiobookshelf already knows about. */
function localItemPath(ctx: AppContext, item: AbsItem): string | null {
  if (!item.path) return null;
  const mapped = mapAbsPathToLocal(item.path, ctx.config.audiobookshelf.pathMappings);
  return mapped || null;
}

async function syncOneItem(
  ctx: AppContext,
  outcome: MatchOutcome,
): Promise<ItemSyncOutcome | null> {
  const { item, book } = outcome;
  if (!book) return null;

  const link = getLinkBySource(ctx.db, book.source_id);
  saveLink(ctx.db, {
    sourceId: book.source_id,
    itemId: item.id,
    libraryId: item.libraryId,
    path: item.path,
    confidence: outcome.score,
  });

  const desired = buildSidecar(book, ctx.config);
  const current = itemToSidecar(item);
  const previous = previousPayload(link);
  const reconciled = reconcileSidecar(desired, current, previous, ctx.config.sync.writePolicy);
  const hash = sidecarHash(reconciled.payload);

  const result: ItemSyncOutcome = {
    sourceId: book.source_id,
    itemId: item.id,
    title: book.title,
    changedFields: reconciled.changedFields,
    skippedFields: reconciled.skippedFields,
    wrote: false,
    scanned: false,
  };

  const coverMissing = book.cover_url !== null && !(await coverPresent(ctx, book));
  if (!reconciled.changed && link?.written_hash === hash && !coverMissing) {
    return result;
  }

  const cover = await ensureCover(ctx, book);
  const staged = await stageBook(book, reconciled.payload, cover, ctx.config);

  const targetDir = localItemPath(ctx, item);
  if (!targetDir) {
    result.error = "item has no filesystem path; check audiobookshelf.pathMappings";
    return result;
  }

  const placement = await placeIntoLibrary(staged, targetDir, "metadata-only", ctx.config);
  if (placement.errors.length > 0) {
    result.error = placement.errors.join("; ");
    return result;
  }

  result.wrote = placement.copied.length > 0 || placement.linked.length > 0;
  recordWrite(ctx.db, book.source_id, item.id, reconciled.payload, hash);

  if (result.wrote && ctx.config.audiobookshelf.triggerScan) {
    await ctx.abs.scanItem(item.id);
    result.scanned = true;
    if (ctx.config.audiobookshelf.embedIntoAudioFiles && item.numAudioFiles) {
      try {
        await ctx.abs.embedMetadata(item.id);
      } catch (error) {
        result.error = `embed failed: ${String(error)}`;
      }
    }
  }

  return result;
}

async function coverPresent(ctx: AppContext, book: BookWithPeople): Promise<boolean> {
  return (await cachedCover(book, ctx.config)) !== null;
}

/**
 * Reconcile the whole library: match items to source books, refresh their sidecars and, when
 * enabled, prepare folders for subscribed books that are not in the library yet.
 */
export async function syncLibrary(ctx: AppContext): Promise<SyncResult> {
  const result: SyncResult = {
    libraries: 0,
    items: 0,
    matched: 0,
    unmatched: 0,
    written: 0,
    created: 0,
    errors: [],
    outcomes: [],
  };

  if (!ctx.abs.configured) {
    result.errors.push("Audiobookshelf is not configured (ABS_URL / ABS_API_KEY)");
    return result;
  }

  const libraries = await ctx.abs.bookLibraries(ctx.config.audiobookshelf.libraryIds);
  result.libraries = libraries.length;

  for (const library of libraries) {
    const items = await ctx.abs.items(library.id);
    result.items += items.length;

    for (const item of items) {
      const outcome = matchItem(ctx.db, item, ctx.config);
      if (!outcome.book) {
        result.unmatched += 1;
        continue;
      }
      result.matched += 1;
      try {
        const synced = await syncOneItem(ctx, outcome);
        if (!synced) continue;
        result.outcomes.push(synced);
        if (synced.wrote) result.written += 1;
        if (synced.error) result.errors.push(`${item.id}: ${synced.error}`);
      } catch (error) {
        result.errors.push(`${item.id}: ${String(error)}`);
      }
    }
  }

  if (ctx.config.sync.createFolders) {
    result.created = await createPendingFolders(ctx, result);
  }

  setMeta(ctx.db, "sync_ran_at", new Date().toISOString());
  log.info(
    `sync: ${result.items} items in ${result.libraries} libraries, ${result.matched} matched, ${result.written} updated, ${result.created} created`,
  );
  return result;
}

/**
 * Materialise a folder in the library for accepted queue entries that Audiobookshelf does not
 * have yet, so the metadata and cover are already in place when audio is added later.
 */
async function createPendingFolders(ctx: AppContext, result: SyncResult): Promise<number> {
  const libraryRoot = ctx.config.paths.absLibrary;
  if (!libraryRoot) {
    result.errors.push("sync.createFolders is on but paths.absLibrary is empty");
    return 0;
  }

  const rows = ctx.db
    .query<{ source_id: number }, []>(
      "select source_id from queue where state = 'accepted' order by datetime(created_at) limit 50",
    )
    .all();

  let created = 0;
  for (const row of rows) {
    const book = getBook(ctx.db, row.source_id);
    if (!book || book.detail_state !== "ok") continue;
    if (getLinkBySource(ctx.db, row.source_id)) continue;

    try {
      const sidecar: Sidecar = buildSidecar(book, ctx.config);
      const cover = await ensureCover(ctx, book);
      const staged = await stageBook(book, sidecar, cover, ctx.config);
      const targetDir = resolve(libraryRoot, targetFolderFor(book, ctx.config));
      const placement = await placeIntoLibrary(staged, targetDir, "full", ctx.config);
      if (placement.errors.length > 0) {
        result.errors.push(`${row.source_id}: ${placement.errors.join("; ")}`);
        continue;
      }
      setQueueState(ctx, row.source_id, "prepared", targetDir);
      created += 1;
    } catch (error) {
      result.errors.push(`${row.source_id}: ${String(error)}`);
    }
  }

  if (created > 0 && ctx.config.audiobookshelf.triggerScan) {
    const libraries = await ctx.abs.bookLibraries(ctx.config.audiobookshelf.libraryIds);
    for (const library of libraries) {
      try {
        await ctx.abs.scanLibrary(library.id);
      } catch (error) {
        log.warn(`library scan failed for ${library.id}: ${String(error)}`);
      }
    }
  }

  return created;
}

export interface UnmatchedItem {
  itemId: string;
  libraryId: string;
  title: string;
  authors: string[];
  path: string;
  candidates: Array<{ sourceId: number; title: string; authors: string[]; score: number }>;
}

/** Items the matcher was not confident about, with suggestions for a manual decision. */
export async function listUnmatched(ctx: AppContext, limit = 50): Promise<UnmatchedItem[]> {
  if (!ctx.abs.configured) return [];
  const libraries = await ctx.abs.bookLibraries(ctx.config.audiobookshelf.libraryIds);
  const unmatched: UnmatchedItem[] = [];

  for (const library of libraries) {
    for (const item of await ctx.abs.items(library.id)) {
      if (unmatched.length >= limit) return unmatched;
      const outcome = matchItem(ctx.db, item, ctx.config);
      if (outcome.book) continue;
      unmatched.push({
        itemId: item.id,
        libraryId: item.libraryId,
        title: item.title,
        authors: item.authors,
        path: item.path,
        candidates: outcome.candidates.map((candidate) => ({
          sourceId: candidate.book.source_id,
          title: candidate.book.title,
          authors: candidate.book.authors,
          score: Number(candidate.score.toFixed(3)),
        })),
      });
    }
  }

  return unmatched;
}

/** Force a single book's metadata into a specific library item, pinning the association. */
export async function syncSingle(ctx: AppContext, sourceId: number, itemId: string): Promise<ItemSyncOutcome> {
  const book = getBook(ctx.db, sourceId);
  if (!book) throw new Error(`unknown book ${sourceId}`);
  const item = await ctx.abs.item(itemId);
  saveLink(ctx.db, {
    sourceId,
    itemId,
    libraryId: item.libraryId,
    path: item.path,
    confidence: 1,
    pinned: true,
  });
  const outcome = await syncOneItem(ctx, { item, book, score: 1, via: "existing-link", candidates: [] });
  if (!outcome) throw new Error("sync produced no result");
  return outcome;
}
