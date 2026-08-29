import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { BookWithPeople } from "./catalog/store.ts";
import { stagingDirFor } from "./abs/stage.ts";
import { logger } from "./log.ts";
import type { Fetcher } from "./fetch/fetcher.ts";

const log = logger("cover");

const COVER_MARKER = ".4read-cover-source";
const EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface CachedCover {
  path: string;
  contentType: string;
}

/** The cover already downloaded into this book's staging folder, if any. */
export async function cachedCover(book: BookWithPeople, config: Config): Promise<CachedCover | null> {
  const dir = stagingDirFor(book, config);
  for (const extension of EXTENSIONS) {
    const path = join(dir, `cover${extension}`);
    if (await Bun.file(path).exists()) {
      return { path, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" };
    }
  }
  return null;
}

export interface DownloadedCover {
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * Download the cover unless the staging folder already holds the one for this exact URL.
 * Returns null when nothing needs to be written, which callers treat as "keep what is there".
 */
export async function downloadCoverIfStale(
  fetcher: Fetcher,
  book: BookWithPeople,
  config: Config,
): Promise<DownloadedCover | null> {
  if (!book.cover_url) return null;
  const dir = stagingDirFor(book, config);
  const markerPath = join(dir, COVER_MARKER);

  try {
    const marker = await readFile(markerPath, "utf8");
    if (marker.trim() === book.cover_url) return null;
  } catch {
    // No marker yet, so this cover has not been fetched.
  }

  const result = await fetcher.getBinary(book.cover_url, { referer: book.url });
  await mkdir(dir, { recursive: true });
  await writeFile(markerPath, book.cover_url);
  return { bytes: result.bytes, contentType: result.contentType };
}

const inFlight = new Set<number>();

/**
 * Fetch a cover in the background so the web interface never blocks on the source, which is
 * paced by the rate limiter and can be in a long cooldown.
 */
export function cacheCoverInBackground(
  fetcher: Fetcher,
  book: BookWithPeople,
  config: Config,
  write: (cover: DownloadedCover) => Promise<void>,
): void {
  if (!book.cover_url || inFlight.has(book.source_id)) return;
  inFlight.add(book.source_id);

  void (async () => {
    try {
      const cover = await downloadCoverIfStale(fetcher, book, config);
      if (cover) await write(cover);
    } catch (error) {
      log.debug(`background cover fetch failed for ${book.source_id}: ${String(error)}`);
    } finally {
      inFlight.delete(book.source_id);
    }
  })();
}

