import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config } from "../config.ts";
import type { BookWithPeople } from "../catalog/store.ts";
import type { Fetcher } from "../fetch/fetcher.ts";
import { isMediaFile } from "../abs/stage.ts";
import { parseBookUrl, bookUrl } from "../source/urls.ts";
import { logger } from "../log.ts";

const log = logger("audio");

const PLAYLIST_MARKER = ".4read-audio-playlist";
/** Expected track list for UI + partial resume (written as soon as the m3u is parsed). */
const TRACKS_MANIFEST = ".4read-audio-tracks.json";

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

export type AudioTrackStatus = "downloaded" | "pending";

/** One expected track for the queue UI / resume logic. */
export interface AudioTrackInfo {
  /** Source path without domain or query, e.g. `2901/01.mp3`. */
  name: string;
  /** Local staging filename, e.g. `0001-01.mp3`. */
  file: string;
  status: AudioTrackStatus;
}

export interface AudioStatus {
  files: AudioTrackInfo[];
  downloaded: number;
  total: number;
  complete: boolean;
}

interface TracksManifest {
  playlistUrl: string;
  tracks: Array<{ file: string; name: string }>;
}

/** Playlist path segment: `{id}-{slug}` matching the article basename without `.html`. */
const PLAYLIST_KEY_RE = /^\d+-[a-zA-Z0-9][\w.-]{0,180}$/;

/**
 * Source path for display / resume identity: no domain, no query/hash.
 * `https://reasd.org/2901/01.mp3?expires=1&md5=x` → `2901/01.mp3`
 */
export function trackSourcePath(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    const noQuery = url.split(/[?#]/)[0] ?? url;
    return noQuery.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+/, "");
  }
}

async function writeTracksManifest(
  dir: string,
  playlistUrl: string,
  tracks: PlaylistTrack[],
): Promise<void> {
  const payload: TracksManifest = {
    playlistUrl,
    tracks: tracks.map((track, index) => ({
      file: trackFileName(index, track),
      name: trackSourcePath(track.url),
    })),
  };
  await writeFile(join(dir, TRACKS_MANIFEST), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readTracksManifest(dir: string): Promise<TracksManifest | null> {
  try {
    const raw = await readFile(join(dir, TRACKS_MANIFEST), "utf8");
    const parsed = JSON.parse(raw) as TracksManifest;
    if (!parsed || !Array.isArray(parsed.tracks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Status of expected / present audio files in a staging folder (for the queue UI). */
export async function readAudioStatus(dir: string, minFileBytes: number): Promise<AudioStatus> {
  const manifest = await readTracksManifest(dir);
  if (manifest?.tracks.length) {
    const files: AudioTrackInfo[] = [];
    for (const track of manifest.tracks) {
      const done = await fileLooksComplete(join(dir, track.file), minFileBytes);
      files.push({
        name: track.name || track.file,
        file: track.file,
        status: done ? "downloaded" : "pending",
      });
    }
    const downloaded = files.filter((f) => f.status === "downloaded").length;
    return {
      files,
      downloaded,
      total: files.length,
      complete: downloaded === files.length && files.length > 0,
    };
  }

  // Legacy folder: no manifest yet — list whatever media is on disk as downloaded.
  const files: AudioTrackInfo[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (!isMediaFile(name)) continue;
      if (!(await fileLooksComplete(join(dir, name), minFileBytes))) continue;
      files.push({ name, file: name, status: "downloaded" });
    }
  } catch {
    // Missing dir.
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return {
    files,
    downloaded: files.length,
    total: files.length,
    complete: files.length > 0,
  };
}

/**
 * 4read playlist id is the article path without `.html`:
 * `https://4read.org/5546-garri-garrison-….html` → `5546-garri-garrison-…`
 * (not the slug alone). Prefer the book URL; fall back to `source_id` + slug.
 */
export function playlistKeyFor(book: {
  source_id?: number;
  slug: string;
  url?: string | null;
}): string | null {
  const fromUrl = book.url ? parseBookUrl(book.url) : null;
  const candidates: string[] = [];
  if (fromUrl?.slug) candidates.push(`${fromUrl.sourceId}-${fromUrl.slug}`);
  if (book.source_id && book.slug) candidates.push(`${book.source_id}-${book.slug}`);
  // Already a full key in slug field (legacy / manual).
  if (book.slug && /^\d+-/.test(book.slug)) candidates.push(book.slug);

  for (const candidate of candidates) {
    let decoded = candidate;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // keep raw
    }
    if (/[<>]/.test(decoded) || /<html/i.test(decoded)) continue;
    if (PLAYLIST_KEY_RE.test(candidate)) return candidate;
    if (PLAYLIST_KEY_RE.test(decoded)) return decoded;
  }
  return null;
}

/** @deprecated Use playlistKeyFor */
export function playlistSlugFor(book: {
  source_id?: number;
  slug: string;
  url?: string | null;
}): string | null {
  return playlistKeyFor(book);
}

export function playlistUrlFor(
  book: { source_id?: number; slug: string; url?: string | null },
  config: Config,
): string | null {
  const key = playlistKeyFor(book);
  if (!key) return null;
  const base = config.source.baseUrl.replace(/\/+$/, "");
  return `${base}/m33u2/${encodeURIComponent(key)}.m3u`;
}

/** True when a playlist GET clearly returned a web page instead of M3U. */
export function looksLikeHtmlDocument(raw: string): boolean {
  const head = raw.trim().slice(0, 256).toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.includes("<head") ||
    head.includes("just a moment") ||
    head.includes("_cf_chl")
  );
}

/**
 * Parse an M3U / M3U8 body into ordered track URLs. Supports `#EXTINF` titles and bare URL lists.
 * Rejects HTML scraps — Cloudflare challenge pages must not become relative "track" URLs.
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
    // HTML tags / challenge pages must never resolve against the playlist base URL.
    if (/[<>]/.test(line) || /\s/.test(line)) continue;
    if (!isPlausibleTrackRef(line)) continue;

    let url = line;
    if (baseUrl && !/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        continue;
      }
    }
    if (!isPlausibleTrackUrl(url)) continue;
    tracks.push({ url, title: pendingTitle });
    pendingTitle = null;
  }

  return tracks;
}

function isPlausibleTrackRef(line: string): boolean {
  if (/^https?:\/\//i.test(line)) return true;
  // Relative media: `files/1.mp3`, `a.mp3`, `../audio/b.m4b`
  if (!/^[\w./%-]+$/i.test(line)) return false;
  return line.includes("/") || /\.(mp3|m4a|m4b|flac|ogg|opus)(\?.*)?$/i.test(line);
}

function isPlausibleTrackUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    if (/[<>]/.test(path) || /<html/i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
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

/**
 * FlareSolverr returns page HTML for text GETs; peel a bare M3U out of a wrapper if needed.
 * Returns an empty string when the body is an HTML document with no embedded playlist —
 * otherwise `<html…>` would be parsed as a relative track path under `/m33u2/`.
 */
export function extractPlaylistBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#EXTM3U")) return trimmed;
  // Bare URL-only playlist (no EXTINF header) — only when the whole body is the list.
  if (/^https?:\/\//i.test(trimmed) && !/[<>]/.test(trimmed)) return trimmed;

  const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (pre?.[1]) return pre[1].trim();
  const start = trimmed.indexOf("#EXTM3U");
  if (start >= 0) return trimmed.slice(start);

  if (looksLikeHtmlDocument(trimmed)) return "";
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
 * Drop playlist marker and media files so the next accept/download re-fetches audio.
 * Leaves metadata.json / cover.* alone.
 */
export async function clearDownloadedAudio(dir: string): Promise<number> {
  let removed = 0;
  try {
    await rm(join(dir, PLAYLIST_MARKER), { force: true });
  } catch {
    // ignore
  }
  try {
    await rm(join(dir, TRACKS_MANIFEST), { force: true });
  } catch {
    // ignore
  }
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !isMediaFile(entry.name)) continue;
      await rm(join(dir, entry.name), { force: true });
      removed += 1;
    }
  } catch {
    // Missing folder is fine.
  }
  if (removed > 0) log.info(`cleared ${removed} audio file(s) from ${dir}`);
  return removed;
}

/**
 * Wipe a book working folder (audio, cover, metadata, marker) so Delete → re-Accept
 * starts clean — including the UI cover preview cache.
 */
export async function clearBookFolder(dir: string): Promise<{ audio: number; wiped: boolean }> {
  const audio = await clearDownloadedAudio(dir);
  try {
    await rm(dir, { recursive: true, force: true });
    log.info(`wiped book folder ${dir}`);
    return { audio, wiped: true };
  } catch {
    return { audio, wiped: false };
  }
}

/**
 * Article page used as Referer when fetching `/m33u2/{id}-{slug}.m3u`.
 * Always on `source.baseUrl`, e.g. `https://4read.org/5546-garri-garrison-….html`.
 */
export function bookPageReferer(
  book: { source_id: number; slug: string; url?: string | null },
  config: Config,
): string {
  const base = config.source.baseUrl.replace(/\/+$/, "");
  const key = playlistKeyFor(book);
  if (key) return `${base}/${key}.html`;
  return bookUrl(book.source_id, book.slug, base);
}

/**
 * Pull the player playlist URL from book HTML, e.g.
 * `new Playerjs({file:"https://4read.org/m33u2/5546-….m3u"})`.
 * When `preferKey` is set (e.g. `2901-slug`), prefer a URL whose path contains that key
 * so related-book embeds on the same page do not steal the match.
 */
export function extractPlaylistUrlFromHtml(
  html: string,
  baseUrl?: string,
  preferKey?: string | null,
): string | null {
  const patterns = [
    /Playerjs\(\s*\{[^}]*\bfile\s*:\s*["']([^"']*m33u2[^"']+\.m3u[^"']*)["']/gi,
    /["'](https?:\/\/[^"']*\/m33u2\/[^"']+\.m3u[^"']*)["']/gi,
    /["'](\/m33u2\/[^"']+\.m3u[^"']*)["']/gi,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      try {
        const href = new URL(raw, baseUrl ?? "https://4read.org/").href;
        if (!found.includes(href)) found.push(href);
      } catch {
        // skip
      }
    }
    if (found.length) break; // Prefer Playerjs matches over loose URL scans.
  }
  if (found.length === 0) return null;
  if (preferKey) {
    const needle = preferKey.toLowerCase();
    const preferred = found.find((url) => {
      try {
        return decodeURIComponent(new URL(url).pathname).toLowerCase().includes(needle);
      } catch {
        return url.toLowerCase().includes(needle);
      }
    });
    // When preferKey is set but nothing matches (wrong page HTML from a session race, or
    // only related-book embeds), return null so the caller uses the constructed {id}-{slug} URL.
    return preferred ?? null;
  }
  return found[0] ?? null;
}

interface HarLike {
  log?: {
    entries?: Array<{
      request?: { url?: string };
      response?: {
        content?: { text?: string; encoding?: string; mimeType?: string };
        status?: number;
      };
    }>;
  };
}

/**
 * If Chrome recorded a HAR while loading the book page, reuse the m33u2 response body
 * (and URL) from that network traffic instead of issuing a second playlist GET.
 */
export function extractPlaylistFromHar(
  har: unknown,
): { url: string; body: string } | null {
  const entries = (har as HarLike | null)?.log?.entries;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const url = entry.request?.url ?? "";
    if (!/\/m33u2\/.+\.m3u(\?|$)/i.test(url)) continue;
    const content = entry.response?.content;
    let text = content?.text ?? "";
    if (!text) continue;
    if (content?.encoding === "base64") {
      try {
        text = Buffer.from(text, "base64").toString("utf8");
      } catch {
        continue;
      }
    }
    const body = extractPlaylistBody(text);
    if (body) return { url, body };
  }
  return null;
}

/**
 * Load the book page in Chrome, prefer the m3u body from page network/HAR or the Playerjs
 * URL embedded in HTML, then download tracks. Soft-skips when the playlist is empty.
 */
export async function ensureAudioFromPlaylist(
  book: BookWithPeople,
  dir: string,
  config: Config,
  fetcher: Fetcher,
): Promise<AudioFetchResult | null> {
  const constructedUrl = playlistUrlFor(book, config);
  const referer = bookPageReferer(book, config);

  const markerPath = join(dir, PLAYLIST_MARKER);
  const markerCandidate = constructedUrl;

  // Resume: if every expected track from a prior manifest is already on disk, skip network.
  // Partial folders must NOT early-return — missing tracks still need a fresh m3u + download.
  {
    const prior = await readAudioStatus(dir, config.audio.minFileBytes);
    if (prior.complete && prior.total > 0) {
      let markerOk = false;
      try {
        const marker = (await readFile(markerPath, "utf8")).trim();
        markerOk = Boolean(markerCandidate && marker === markerCandidate);
      } catch {
        markerOk = prior.complete;
      }
      if (markerOk || !markerCandidate) {
        log.debug(
          `audio already complete for ${book.source_id} (${prior.downloaded}/${prior.total} files)`,
        );
        return {
          playlistUrl: markerCandidate ?? prior.files[0]?.file ?? "",
          tracks: prior.total,
          downloaded: 0,
          skipped: prior.downloaded,
          files: prior.files.map((f) => join(dir, f.file)),
        };
      }
    }
  }

  log.info(`audio: loading book page for playlist discovery ${book.source_id} → page=${referer}`);

  let playlistUrl = constructedUrl;
  let body: string | null = null;
  /** How we chose the m3u URL / body: executejs | har | playerjs | constructed */
  let discovery: "executejs" | "har" | "playerjs" | "constructed" | null = constructedUrl
    ? "constructed"
    : null;

  try {
    const page = await fetcher.warmBookPage(referer, { fetchPlaylistUrl: constructedUrl });
    if (page?.playlistBody) {
      body = extractPlaylistBody(page.playlistBody);
      if (body) {
        discovery = "executejs";
        log.info(
          `audio: m3u source=executejs (in-page fetch while loading book HTML) for ${book.source_id} → m3u=${playlistUrl} page=${referer}`,
        );
      }
    }
    if (!body && page?.har) {
      const fromHar = extractPlaylistFromHar(page.har);
      if (fromHar) {
        playlistUrl = fromHar.url;
        body = fromHar.body;
        discovery = "har";
        log.info(
          `audio: m3u source=har (Chrome network while loading page) for ${book.source_id} → m3u=${playlistUrl} page=${referer}`,
        );
      } else {
        log.info(
          `audio: HAR present but no /m33u2/*.m3u entry for ${book.source_id} page=${referer}`,
        );
      }
    } else if (!body) {
      log.info(
        `audio: no executeJs/HAR playlist for ${book.source_id}; trying Playerjs HTML then constructed URL page=${referer}`,
      );
    }
    if (!body && page?.body) {
      const preferKey = playlistKeyFor(book);
      const fromHtml = extractPlaylistUrlFromHtml(page.body, config.source.baseUrl, preferKey);
      if (fromHtml) {
        playlistUrl = fromHtml;
        discovery = "playerjs";
        log.info(
          `audio: m3u source=playerjs (URL from Playerjs file= in HTML) for ${book.source_id} → m3u=${playlistUrl} page=${referer}`,
        );
      } else {
        log.info(
          `audio: no Playerjs m3u URL in HTML for ${book.source_id}; will use constructed path page=${referer}`,
        );
      }
    }
  } catch (error) {
    log.debug(`book page warm-up error for ${book.source_id}: ${String(error)}`);
  }

  if (!playlistUrl) {
    log.warn(
      `audio skipped for ${book.source_id}: cannot resolve playlist URL page=${referer}`,
    );
    return null;
  }

  if (!body) {
    if (discovery === "constructed") {
      log.info(
        `audio: m3u source=constructed ({id}-{slug} from book URL) for ${book.source_id} → m3u=${playlistUrl} page=${referer}`,
      );
    }
    try {
      log.info(
        `audio: fetching playlist (source=${discovery ?? "unknown"}; direct GET or Chrome download) for ${book.source_id} → m3u=${playlistUrl} page=${referer}`,
      );
      const text = await fetcher.getPlaylistText(playlistUrl, { referer });
      body = extractPlaylistBody(text.body);
      if (!body) {
        log.warn(
          `playlist body not M3U after fetch (source=${discovery ?? "unknown"}) bytes=${text.body.length} head=${JSON.stringify(text.body.trim().slice(0, 80))} m3u=${playlistUrl} page=${referer}`,
        );
      }
    } catch (error) {
      log.warn(
        `playlist fetch failed for ${book.slug} (source=${discovery ?? "unknown"}) m3u=${playlistUrl} page=${referer}: ${String(error)}`,
      );
      return null;
    }
  }

  if (!body) {
    log.warn(
      `playlist for ${book.slug} returned HTML/empty instead of M3U (source=${discovery ?? "unknown"}) m3u=${playlistUrl} page=${referer} — Cloudflare or wrong URL?`,
    );
    return null;
  }

  // Re-fetch m3u via executeJs on the book page (not download:true) so signed CDN URLs are
  // fresh if Playerjs raced the first fetch — and so we do not poison Flare download mode.
  if (playlistUrl && referer) {
    try {
      const refreshed = await fetcher.warmBookPage(referer, { fetchPlaylistUrl: playlistUrl });
      const freshBody = refreshed?.playlistBody
        ? extractPlaylistBody(refreshed.playlistBody)
        : null;
      if (freshBody) {
        body = freshBody;
        log.info(
          `audio: refreshed m3u before tracks for ${book.source_id} (${freshBody.length} bytes) page=${referer}`,
        );
      }
    } catch (error) {
      log.debug(`m3u refresh before tracks failed for ${book.source_id}: ${String(error)}`);
    }
  }

  const tracks = parseM3u(body, playlistUrl);
  if (tracks.length === 0) {
    log.warn(
      `playlist empty for ${book.slug} (source=${discovery ?? "unknown"}) m3u=${playlistUrl} page=${referer}`,
    );
    return null;
  }

  await mkdir(dir, { recursive: true });
  await writeTracksManifest(dir, playlistUrl, tracks);

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
      log.debug(`skip existing ${name} for ${book.source_id}`);
      continue;
    }
    try {
      const binary = await fetcher.getBinary(track.url, {
        // Book HTML — CDN hotlink checks Referer; m3u URL is wrong here.
        referer,
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

  // Only mark the playlist complete when every expected track is on disk — partial runs
  // must resume missing files on the next sync/accept.
  if (files.length === tracks.length && playlistUrl) {
    await writeFile(markerPath, playlistUrl);
  }

  log.info(
    `audio for ${book.source_id} (${book.slug}): ${downloaded} downloaded, ${skipped} skipped, ${files.length}/${tracks.length} ready`,
  );

  return { playlistUrl, tracks: tracks.length, downloaded, skipped, files };
}
