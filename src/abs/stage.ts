import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { logger } from "../log.ts";
import { safeFileName } from "../catalog/normalize.ts";
import type { BookWithPeople } from "../catalog/store.ts";
import { serialiseSidecar, type Sidecar } from "./metadata.ts";

const log = logger("stage");

/** Extensions Audiobookshelf treats as media. Large and immutable, so worth hardlinking. */
const MEDIA_EXTENSIONS = new Set(
  [
    "m4b", "mp3", "m4a", "flac", "opus", "ogg", "oga", "mp4", "aac", "wma", "aiff", "aif",
    "wav", "webm", "webma", "mka", "awb", "caf", "mpg", "mpeg",
    "epub", "pdf", "mobi", "azw3", "cbr", "cbz",
  ].map((ext) => `.${ext}`),
);

export function isMediaFile(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

/** True when `dir` already holds at least one Audiobookshelf media file. */
export async function folderHasMedia(dir: string): Promise<boolean> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && isMediaFile(entry.name)) return true;
    }
  } catch {
    // Missing folder = no media yet.
  }
  return false;
}

export interface StagedBook {
  dir: string;
  metadataPath: string;
  coverPath: string | null;
  mediaFiles: string[];
}

export function stagingDirFor(book: { source_id: number; slug: string }, config: Config): string {
  const name = safeFileName(`${book.source_id}-${book.slug || "book"}`, 150);
  return resolve(config.paths.staging, name);
}

function coverExtension(contentType: string | null, url: string | null): string {
  const fromType = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (fromType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      break;
  }
  const fromUrl = url ? extname(new URL(url, "https://example.invalid").pathname).toLowerCase() : "";
  // Audiobookshelf accepts png, jpg, jpeg and webp, so the original format can be kept.
  return [".jpg", ".jpeg", ".png", ".webp"].includes(fromUrl) ? fromUrl : ".jpg";
}

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.tmp-${basename(path)}-${process.pid}`);
  await writeFile(temporary, data);
  await rename(temporary, path);
}

/**
 * Build the per-book working folder. Everything is assembled here first so the library only
 * ever sees a complete book.
 */
export async function stageBook(
  book: BookWithPeople,
  sidecar: Sidecar,
  cover: { bytes: Uint8Array; contentType: string | null } | null,
  config: Config,
): Promise<StagedBook> {
  const dir = stagingDirFor(book, config);
  await mkdir(dir, { recursive: true });

  const metadataPath = join(dir, "metadata.json");
  await writeAtomic(metadataPath, serialiseSidecar(sidecar));

  let coverPath: string | null = null;
  if (cover) {
    const extension = coverExtension(cover.contentType, book.hardcover_cover_url ?? book.cover_url);
    coverPath = join(dir, `cover${extension}`);
    // Drop covers in other formats so the folder never holds two candidates.
    for (const candidate of [".jpg", ".jpeg", ".png", ".webp"]) {
      if (candidate === extension) continue;
      await rm(join(dir, `cover${candidate}`), { force: true });
    }
    await writeAtomic(coverPath, cover.bytes);
  } else {
    for (const candidate of [".jpg", ".jpeg", ".png", ".webp"]) {
      const existing = join(dir, `cover${candidate}`);
      if (await exists(existing)) {
        coverPath = existing;
        break;
      }
    }
  }

  const mediaFiles: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && isMediaFile(entry.name)) mediaFiles.push(join(dir, entry.name));
  }

  return { dir, metadataPath, coverPath, mediaFiles };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type PlacementMode = "metadata-only" | "full";

export interface PlacementReport {
  target: string;
  copied: string[];
  linked: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Hardlink a file, falling back to a copy when the target lives on another filesystem or the
 * link limit is hit.
 */
async function linkOrCopy(source: string, target: string, config: Config): Promise<"linked" | "copied"> {
  if (config.sync.linkMode === "copy") {
    await copyFile(source, target);
    return "copied";
  }
  try {
    await link(source, target);
    return "linked";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Already the same content path; treat as done.
      const [a, b] = await Promise.all([stat(source), stat(target)]);
      if (a.ino === b.ino && a.dev === b.dev) return "linked";
      await unlink(target);
      return linkOrCopy(source, target, config);
    }
    if (code === "EXDEV" || code === "EMLINK" || code === "EPERM" || code === "ENOTSUP") {
      if (config.sync.onCrossDevice === "error") {
        throw new Error(`cannot hardlink ${source} -> ${target} (${code}); set sync.onCrossDevice: copy`);
      }
      log.debug(`hardlink unavailable (${code}), copying ${basename(source)}`);
      await copyFile(source, target);
      return "copied";
    }
    throw error;
  }
}

/** Skip work when the target already matches, so repeat runs are cheap and quiet. */
async function sameContent(source: string, target: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(source), stat(target)]);
    if (a.ino === b.ino && a.dev === b.dev) return true;
    if (a.size !== b.size) return false;
    const [left, right] = await Promise.all([Bun.file(source).bytes(), Bun.file(target).bytes()]);
    if (left.length !== right.length) return false;
    return Bun.hash(left) === Bun.hash(right);
  } catch {
    return false;
  }
}

/**
 * Move the staged folder's contents into the library.
 *
 * Media files are hardlinked so nothing is stored twice. Small metadata files are always
 * copied: Audiobookshelf rewrites `metadata.json` in place when a user edits an item, and a
 * hardlink would silently rewrite our staging copy too.
 */
export async function placeIntoLibrary(
  staged: StagedBook,
  targetDir: string,
  mode: PlacementMode,
  config: Config,
): Promise<PlacementReport> {
  const report: PlacementReport = { target: targetDir, copied: [], linked: [], skipped: [], errors: [] };
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(staged.dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Dotfiles are our own bookkeeping (the cover source marker, partial writes) and have no
    // business in the library.
    if (entry.name.startsWith(".")) continue;

    const media = isMediaFile(entry.name);
    if (mode === "metadata-only" && media) {
      report.skipped.push(entry.name);
      continue;
    }

    const source = join(staged.dir, entry.name);
    const target = join(targetDir, entry.name);

    try {
      if (await sameContent(source, target)) {
        report.skipped.push(entry.name);
        continue;
      }
      if (media) {
        await rm(target, { force: true });
        const how = await linkOrCopy(source, target, config);
        (how === "linked" ? report.linked : report.copied).push(entry.name);
      } else {
        // Atomic replace keeps a scanner from reading a half written sidecar.
        const temporary = join(targetDir, `.tmp-${entry.name}-${process.pid}`);
        await copyFile(source, temporary, 0);
        await rename(temporary, target);
        report.copied.push(entry.name);
      }
    } catch (error) {
      report.errors.push(`${entry.name}: ${String(error)}`);
    }
  }

  void constants;
  return report;
}

/** Library-relative folder for a book that is not in Audiobookshelf yet. */
export function targetFolderFor(book: BookWithPeople, config: Config): string {
  const author = safeFileName(book.authors[0] ?? "Unknown Author");
  const series = book.series_name ? safeFileName(book.series_name) : "";
  const sequence = book.series_seq?.trim();
  const titleBase = sequence ? `${sequence} - ${book.title}` : book.title;
  const title = safeFileName(titleBase);

  const rendered = config.sync.folderTemplate
    .replace(/\{author\}/g, author)
    .replace(/\{series\}/g, series)
    .replace(/\{title\}/g, title)
    .replace(/\{sequence\}/g, sequence ? safeFileName(sequence) : "");

  const segments = rendered
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.join("/");
}
