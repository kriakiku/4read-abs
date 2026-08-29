import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config } from "../config.ts";
import type { BookWithPeople } from "../catalog/store.ts";
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

function trackFileName(index: number, track: PlaylistTrack, total: number): string {
  const width = Math.max(2, String(total).length);
  const prefix = String(index + 1).padStart(width, "0");
  let stem = track.title ? safeStem(track.title) : "";
  if (!stem) {
    try {
      stem = safeStem(basename(new URL(track.url).pathname).replace(/\.[^.]+$/, "")) || `track-${prefix}`;
    } catch {
      stem = `track-${prefix}`;
    }
  }
  let extension = ".mp3";
  try {
    const fromUrl = extname(new URL(track.url).pathname).toLowerCase();
    if ([".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus"].includes(fromUrl)) extension = fromUrl;
  } catch {
    // keep .mp3
  }
  return `${prefix} - ${stem}${extension}`;
}

function safeStem(value: string): string {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.apple.mpegurl,audio/mpegurl,audio/x-mpegurl,text/plain,*/*",
      "user-agent": "4read-abs (playlist fetch)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.text();
}

async function fetchBinary(url: string, timeoutMs: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      accept: "audio/mpeg,audio/*,*/*",
      "user-agent": "4read-abs (audio fetch)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
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
 * in playlist order (`01 - …mp3`, …). Soft-skips when the backend returns nothing useful.
 */
export async function ensureAudioFromPlaylist(
  book: BookWithPeople,
  dir: string,
  config: Config,
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
    body = await fetchText(playlistUrl, config.audio.playlistTimeoutMs);
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
    const name = trackFileName(index, track, tracks.length);
    const path = join(dir, name);
    if (await fileLooksComplete(path, config.audio.minFileBytes)) {
      skipped += 1;
      files.push(path);
      continue;
    }
    try {
      const bytes = await fetchBinary(track.url, config.audio.trackTimeoutMs);
      if (bytes.length < config.audio.minFileBytes) {
        log.warn(`track too small (${bytes.length}B) for ${track.url}`);
        continue;
      }
      await writeAtomic(path, bytes);
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
