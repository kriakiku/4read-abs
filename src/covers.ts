import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { BookWithPeople } from "./catalog/store.ts";
import { stagingDirFor } from "./abs/stage.ts";
import { logger } from "./log.ts";
import { CooldownError, type Fetcher } from "./fetch/fetcher.ts";

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
  /** Weak cache-buster derived from the file's mtime and size. */
  version: string;
}

/** The cover already downloaded into this book's staging folder, if any. */
export async function cachedCover(book: BookWithPeople, config: Config): Promise<CachedCover | null> {
  const dir = stagingDirFor(book, config);
  for (const extension of EXTENSIONS) {
    const path = join(dir, `cover${extension}`);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size < 64) continue;
      return {
        path,
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        version: `${Math.floor(info.mtimeMs)}-${info.size}`,
      };
    } catch {
      // Try the next extension.
    }
  }
  return null;
}

/** Cover URL from the source listing (4read). */
export function preferredCoverUrl(book: BookWithPeople, _config?: Config): string | null {
  return book.cover_url?.trim() || null;
}

/** Browser-facing URL that changes when the cached file changes, so stale covers are not stuck. */
export async function coverProxyUrl(book: BookWithPeople, config: Config): Promise<string | null> {
  if (!preferredCoverUrl(book, config) && !book.cover_url) return null;
  const cached = await cachedCover(book, config);
  if (cached) return `/api/covers/${book.source_id}?v=${cached.version}`;
  // No file yet: still point at the endpoint so a later refresh can pick it up.
  return `/api/covers/${book.source_id}`;
}

export interface DownloadedCover {
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * Download the cover unless the staging folder already holds the one for this exact URL.
 * Returns null when nothing needs to be written, which callers treat as "keep what is there".
 *
 * Source cover URLs share 4read's Cloudflare zone; Bun cannot reuse FlareSolverr clearance
 * cookies (TLS fingerprint), so fetches go through the Fetcher.
 */
export async function downloadCoverIfStale(
  fetcher: Fetcher,
  book: BookWithPeople,
  config: Config,
): Promise<DownloadedCover | null> {
  const url = preferredCoverUrl(book, config);
  if (!url) return null;
  const dir = stagingDirFor(book, config);
  const markerPath = join(dir, COVER_MARKER);

  try {
    const marker = await readFile(markerPath, "utf8");
    if (marker.trim() === url && (await cachedCover(book, config))) return null;
  } catch {
    // No marker yet, so this cover has not been fetched.
  }

  const binary = await fetcher.getBinary(url, { referer: book.url });
  const result: DownloadedCover = { bytes: binary.bytes, contentType: binary.contentType };

  await mkdir(dir, { recursive: true });
  await writeFile(markerPath, url);
  return result;
}

const inFlight = new Set<number>();
const deferredTimers = new Map<number, ReturnType<typeof setTimeout>>();

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
  if (!preferredCoverUrl(book, config) || inFlight.has(book.source_id)) return;
  inFlight.add(book.source_id);

  void (async () => {
    try {
      const cover = await downloadCoverIfStale(fetcher, book, config);
      if (cover) await write(cover);
    } catch (error) {
      if (error instanceof CooldownError) {
        log.debug(`background cover fetch deferred for ${book.source_id}: cooldown`);
        scheduleCoverRetry(fetcher, book, config, write, error.remainingMs);
      } else {
        log.debug(`background cover fetch failed for ${book.source_id}: ${String(error)}`);
      }
    } finally {
      inFlight.delete(book.source_id);
    }
  })();
}

function scheduleCoverRetry(
  fetcher: Fetcher,
  book: BookWithPeople,
  config: Config,
  write: (cover: DownloadedCover) => Promise<void>,
  remainingMs: number,
): void {
  if (deferredTimers.has(book.source_id)) return;
  const wait = Math.min(Math.max(remainingMs + 1_000, 5_000), 15 * 60_000);
  const timer = setTimeout(() => {
    deferredTimers.delete(book.source_id);
    cacheCoverInBackground(fetcher, book, config, write);
  }, wait);
  deferredTimers.set(book.source_id, timer);
}
