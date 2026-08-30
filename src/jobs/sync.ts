import { resolve } from "node:path";
import type { AppContext } from "../context.ts";
import { logger } from "../log.ts";
import { ensureAudioFromPlaylist, clearDownloadedAudio } from "../audio/m3u.ts";
import { downloadCoverIfStale, type DownloadedCover } from "../covers.ts";
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
import {
  folderHasMedia,
  placeIntoLibrary,
  stageBook,
  stagingDirFor,
  targetFolderFor,
} from "../abs/stage.ts";
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

async function ensureAudio(ctx: AppContext, book: BookWithPeople): Promise<number> {
  try {
    const dir = stagingDirFor(book, ctx.config);
    log.info(`audio: ensuring tracks for ${book.source_id} in ${dir}`);
    const result = await ensureAudioFromPlaylist(book, dir, ctx.config, ctx.fetcher);
    const count = result?.files.length ?? 0;
    if (count === 0) {
      log.warn(`audio: no files ready for ${book.source_id} (${book.slug})`);
    }
    return count;
  } catch (error) {
    log.warn(`audio fetch failed for ${book.source_id}: ${String(error)}`);
    return 0;
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

  const targetDir = localItemPath(ctx, item);
  if (!targetDir) {
    result.error = "item has no filesystem path; check audiobookshelf.pathMappings";
    return result;
  }

  // Sidecar/cover already written is not enough — keep trying until the library folder has media.
  const libraryHasMedia = await folderHasMedia(targetDir);
  if (!reconciled.changed && link?.written_hash === hash && libraryHasMedia) {
    await releaseStagingAudio(ctx, book, targetDir);
    return result;
  }

  const cover = await ensureCover(ctx, book);
  const audioCount = libraryHasMedia ? 0 : await ensureAudio(ctx, book);
  const staged = await stageBook(book, reconciled.payload, cover, ctx.config);

  // Place media whenever the library still lacks it and staging has tracks (including marker hits).
  const placeMode =
    !libraryHasMedia && (audioCount > 0 || staged.mediaFiles.length > 0) ? "full" : "metadata-only";
  const placement = await placeIntoLibrary(staged, targetDir, placeMode, ctx.config);
  if (placement.errors.length > 0) {
    result.error = placement.errors.join("; ");
    return result;
  }

  result.wrote = placement.copied.length > 0 || placement.linked.length > 0;
  recordWrite(ctx.db, book.source_id, item.id, reconciled.payload, hash);

  if (placeMode === "full" && (audioCount > 0 || staged.mediaFiles.length > 0) && !result.error) {
    await releaseStagingAudio(ctx, book, targetDir);
  }

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

  if (ctx.config.paths.absLibrary) {
    result.created = await createPendingFolders(ctx, result);
  } else {
    const pending =
      ctx.db
        .query<{ n: number }, []>(
          "select count(*) as n from queue where state in ('accepted', 'prepared')",
        )
        .get()?.n ?? 0;
    if (pending > 0) {
      log.warn(
        `sync: ${pending} accepted/prepared book(s) but paths.absLibrary is empty — set ABS_LIBRARY_DIR / paths.absLibrary`,
      );
    } else if (result.items === 0) {
      log.info("sync: ABS library empty and paths.absLibrary unset — Accept needs absLibrary to create folders");
    }
  }

  setMeta(ctx.db, "sync_ran_at", new Date().toISOString());
  log.info(
    `sync: ${result.items} items in ${result.libraries} libraries, ${result.matched} matched, ${result.written} updated, ${result.created} created`,
  );
  return result;
}

/**
 * Materialise a folder in the library for accepted queue entries that Audiobookshelf does not
 * have yet. Also backfills audio into already-prepared folders that only have metadata/cover.
 */
async function createPendingFolders(ctx: AppContext, result: SyncResult): Promise<number> {
  const libraryRoot = ctx.config.paths.absLibrary;
  if (!libraryRoot) {
    result.errors.push("paths.absLibrary is empty");
    return 0;
  }

  const rows = ctx.db
    .query<{ source_id: number; state: string; note: string | null }, []>(
      `select source_id, state, note from queue
       where state in ('accepted', 'prepared')
       order by datetime(created_at) limit 50`,
    )
    .all();

  let created = 0;
  if (rows.length === 0) {
    const news =
      ctx.db.query<{ n: number }, []>("select count(*) as n from queue where state = 'new'").get()?.n ?? 0;
    log.info(
      `prepare: no accepted/prepared entries` +
        (news > 0 ? ` (${news} still in state=new — accept them in the UI)` : ""),
    );
    return 0;
  }

  for (const row of rows) {
    try {
      const outcome = await prepareAcceptedBook(ctx, row.source_id);
      if (outcome.created) created += 1;
      if (outcome.error && !outcome.ok) {
        result.errors.push(`${row.source_id}: ${outcome.error}`);
      }
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

export interface PrepareOutcome {
  ok: boolean;
  created: boolean;
  audioFiles: number;
  targetDir?: string;
  error?: string;
}

/**
 * Accept path: build the library folder and download audio now.
 * Does not wait for a separate sync job or UI button.
 */
export async function prepareAcceptedBook(ctx: AppContext, sourceId: number): Promise<PrepareOutcome> {
  const libraryRoot = ctx.config.paths.absLibrary;
  if (!libraryRoot) {
    const message = "paths.absLibrary is empty — set ABS_LIBRARY_DIR or paths.absLibrary in config";
    log.warn(`prepare ${sourceId}: ${message}`);
    return { ok: false, created: false, audioFiles: 0, error: message };
  }

  const row = ctx.db
    .query<{ source_id: number; state: string; note: string | null }, [number]>(
      "select source_id, state, note from queue where source_id = ?",
    )
    .get(sourceId);

  const book = getBook(ctx.db, sourceId);
  if (!book) {
    return { ok: false, created: false, audioFiles: 0, error: "book not found" };
  }
  if (book.detail_state !== "ok") {
    const message = `detail not ready (${book.detail_state}) — wait for Fetch details / backfill`;
    log.info(`prepare ${sourceId}: ${message}`);
    return { ok: true, created: false, audioFiles: 0, error: message };
  }
  if (getLinkBySource(ctx.db, sourceId)) {
    log.info(`prepare ${sourceId}: already linked in ABS — library sync will refresh media`);
    return { ok: true, created: false, audioFiles: 0 };
  }

  const state = row?.state ?? "accepted";
  log.info(`prepare: starting ${sourceId} (${book.slug}) state=${state}`);

  if (state === "prepared") {
    const targetDir = row?.note?.trim() || resolve(libraryRoot, targetFolderFor(book, ctx.config));
    if (await folderHasMedia(targetDir)) {
      log.info(`prepare ${sourceId}: library folder already has media`);
      await releaseStagingAudio(ctx, book, targetDir);
      return { ok: true, created: false, audioFiles: 0, targetDir };
    }

    log.info(`backfilling audio for prepared book ${sourceId} (${book.slug})`);
    const sidecar: Sidecar = buildSidecar(book, ctx.config);
    const cover = await ensureCover(ctx, book);
    const audioCount = await ensureAudio(ctx, book);
    const staged = await stageBook(book, sidecar, cover, ctx.config);
    if (audioCount === 0 && staged.mediaFiles.length === 0) {
      return {
        ok: false,
        created: false,
        audioFiles: 0,
        targetDir,
        error: "playlist empty or audio download failed",
      };
    }

    const placement = await placeIntoLibrary(staged, targetDir, "full", ctx.config);
    if (placement.errors.length > 0) {
      return { ok: false, created: false, audioFiles: audioCount, targetDir, error: placement.errors.join("; ") };
    }
    log.info(`prepare ${sourceId}: placed ${audioCount} audio file(s) into ${targetDir}`);
    await releaseStagingAudio(ctx, book, targetDir);
    return { ok: true, created: true, audioFiles: audioCount, targetDir };
  }

  const sidecar: Sidecar = buildSidecar(book, ctx.config);
  const cover = await ensureCover(ctx, book);
  const audioCount = await ensureAudio(ctx, book);
  const staged = await stageBook(book, sidecar, cover, ctx.config);
  const targetDir = resolve(libraryRoot, targetFolderFor(book, ctx.config));
  const placement = await placeIntoLibrary(staged, targetDir, "full", ctx.config);
  if (placement.errors.length > 0) {
    return { ok: false, created: false, audioFiles: audioCount, targetDir, error: placement.errors.join("; ") };
  }
  if (audioCount > 0 || staged.mediaFiles.length > 0) {
    await releaseStagingAudio(ctx, book, targetDir);
  } else {
    setQueueState(ctx, sourceId, "prepared", targetDir);
  }
  log.info(
    `prepare ${sourceId}: created folder ${targetDir} with ${audioCount} audio file(s)` +
      (audioCount === 0 ? " (metadata/cover only — audio failed or empty playlist)" : " → synced, staging audio cleared"),
  );
  return { ok: true, created: true, audioFiles: audioCount, targetDir };
}

/**
 * After media is hardlinked/copied into the ABS library folder, drop staging mp3s
 * (safe with hardlinks) and mark the queue entry as synced.
 */
async function releaseStagingAudio(
  ctx: AppContext,
  book: BookWithPeople,
  libraryDir: string,
): Promise<void> {
  const removed = await clearDownloadedAudio(stagingDirFor(book, ctx.config));
  setQueueState(ctx, book.source_id, "synced", libraryDir);
  if (removed > 0) {
    log.info(`staging audio cleared for ${book.source_id} after ABS place (${removed} file(s))`);
  }
}
