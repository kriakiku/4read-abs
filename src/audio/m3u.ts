import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config } from "../config.ts";
import type { BookWithPeople } from "../catalog/store.ts";
import type { Fetcher } from "../fetch/fetcher.ts";
import { logger } from "../log.ts";

const log = logger("audio");

const PLAYLIST_MARKER = ".4read-audio-playlist";

export interface PlaylistTrack {
  url: string;
  title: string | null;
}

export interface AudioFetchResult {
  playlistUrl: string;
  tracks: number;
  downloaded: number;
  skipped: number;
  files: string[];
}

/** True when DOWNLOAD_BASE / audio.downloadBase is configured. */
export function audioDownloadEnabled(config: Config): boolean {
  return config.audio.downloadBase.length > 0;
}

export function playlistUrlFor(book: { slug: string }, config: Config): string | null {
  if (!audioDownloadEnabled(config) || !book.slug) return null;
  const base = config.audio.downloadBase.replace(/\/+$/, "");
  return `${base}/m33u2/${encodeURIComponent(book.slug)}.m3u`;
}

/**
 * Parse an M3U / M3U8 body into ordered track URLs. Supports `#EXTINF` titles and bare URL lists.
 */
export function parseM3u(body: string, baseUrl?: string): PlaylistTrack[] {
  const tracks: PlaylistTrack[] = [];
  let pendingTitle: string | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTM3U") || line.startsWith("#EXT-X-")) continue;
    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      pendingTitle = comma >= 0 ? line.slice(comma + 1).trim() || null : null;
      continue;
    }
    if (line.startsWith("#")) continue;

    let url = line;
    if (baseUrl && !/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    tracks.push({ url, title: pendingTitle });
    pendingTitle = null;
  }

  return tracks;
}

function originalNameFromUrl(url: string): { stem: string; extension: string } {
  try {
    // Query/hash must not leak into the local filename — only the path basename matters.
    const path = new URL(url).pathname;
    const base = basename(decodeURIComponent(path));
    const extension = extname(base).toLowerCase();
    const stem = safeStem(base.slice(0, base.length - extension.length));
    const allowed = [".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus"];
    return {
      stem,
      extension: allowed.includes(extension) ? extension : ".mp3",
    };
  } catch {
    return { stem: "", extension: ".mp3" };
  }
}

/** Local name: `0001-origName.mp3` (fixed 4-digit index; query params stripped from origName). */
export function trackFileName(index: number, track: PlaylistTrack): string {
  const prefix = String(index + 1).padStart(4, "0");
  const fromUrl = originalNameFromUrl(track.url);
  const stem = fromUrl.stem || (track.title ? safeStem(track.title) : "") || `track-${prefix}`;
  return `${prefix}-${stem}${fromUrl.extension}`;
}

function safeStem(value: string): string {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim()
    .slice(0, 80);
}

/** FlareSolverr returns page HTML for text GETs; peel a bare M3U out of a wrapper if needed. */
export function extractPlaylistBody(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#EXTM3U")) return trimmed;
  // Bare URL-only playlist (no EXTINF header) — only when the whole body is the list.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (pre?.[1]) return pre[1].trim();
  const start = trimmed.indexOf("#EXTM3U");
  if (start >= 0) return trimmed.slice(start);
  return trimmed;
}

async function writeAtomic(path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function fileLooksComplete(path: string, minBytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size >= minBytes;
  } catch {
    return false;
  }
}

/**
 * Fetch `{DOWNLOAD_BASE}/m33u2/{slug}.m3u` and download each listed media file into `dir`
 * in playlist order as `0001-origName.mp3`, … (query/hash stripped from the local name).
 * Uses the shared Fetcher (direct → FlareSolverr Chrome) so challenged hosts still work.
 * Soft-skips when the backend returns nothing useful.
 */
export async function ensureAudioFromPlaylist(
  book: BookWithPeople,
  dir: string,
  config: Config,
  fetcher: Fetcher,
): Promise<AudioFetchResult | null> {
  const playlistUrl = playlistUrlFor(book, config);
  if (!playlistUrl) return null;

  const markerPath = join(dir, PLAYLIST_MARKER);
  try {
    const marker = (await readFile(markerPath, "utf8")).trim();
    if (marker === playlistUrl) {
      const existing = (await readdir(dir)).filter((name) => /\.(mp3|m4a|m4b|flac|ogg|opus)$/i.test(name));
      if (existing.length > 0) {
        log.debug(`audio already present for ${book.source_id} (${existing.length} files)`);
        return {
          playlistUrl,
          tracks: existing.length,
          downloaded: 0,
          skipped: existing.length,
          files: existing.map((name) => join(dir, name)),
        };
      }
    }
  } catch {
    // No marker yet.
  }

  let body: string;
  try {
    const text = await fetcher.getText(playlistUrl);
    body = extractPlaylistBody(text.body);
  } catch (error) {
    log.warn(`playlist fetch failed for ${book.slug}: ${String(error)}`);
    return null;
  }

  const tracks = parseM3u(body, playlistUrl);
  if (tracks.length === 0) {
    log.warn(`playlist empty for ${book.slug} (${playlistUrl})`);
    return null;
  }

  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  let downloaded = 0;
  let skipped = 0;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]!;
    const name = trackFileName(index, track);
    const path = join(dir, name);
    if (await fileLooksComplete(path, config.audio.minFileBytes)) {
      skipped += 1;
      files.push(path);
      continue;
    }
    try {
      const binary = await fetcher.getBinary(track.url, {
        referer: playlistUrl,
        purpose: "media",
      });
      if (binary.bytes.length < config.audio.minFileBytes) {
        log.warn(`track too small (${binary.bytes.length}B) for ${track.url}`);
        continue;
      }
      await writeAtomic(path, binary.bytes);
      downloaded += 1;
      files.push(path);
      log.debug(`downloaded ${name} for ${book.source_id}`);
    } catch (error) {
      log.warn(`track download failed (${track.url}): ${String(error)}`);
    }
  }

  if (files.length > 0) {
    await writeFile(markerPath, playlistUrl);
  }

  log.info(
    `audio for ${book.source_id} (${book.slug}): ${downloaded} downloaded, ${skipped} skipped, ${files.length}/${tracks.length} ready`,
  );

  return { playlistUrl, tracks: tracks.length, downloaded, skipped, files };
}
