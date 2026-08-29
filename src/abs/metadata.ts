import type { Config } from "../config.ts";
import type { BookWithPeople } from "../catalog/store.ts";
import type { AbsItem } from "./client.ts";

/**
 * Exactly the keys Audiobookshelf's `absMetadata` reader accepts for books. Anything else in
 * the file is ignored, and `series` entries must be `"Name #sequence"` strings.
 */
export interface Sidecar {
  title?: string;
  subtitle?: string;
  authors?: string[];
  narrators?: string[];
  series?: string[];
  genres?: string[];
  tags?: string[];
  description?: string;
  publishedYear?: string;
  publisher?: string;
  language?: string;
  isbn?: string;
  asin?: string;
  explicit?: boolean;
  abridged?: boolean;
}

export const SIDECAR_FIELDS: Array<keyof Sidecar> = [
  "title",
  "subtitle",
  "authors",
  "narrators",
  "series",
  "genres",
  "tags",
  "description",
  "publishedYear",
  "publisher",
  "language",
  "isbn",
  "asin",
];

export function sourceTag(book: { source_id: number }, config: Config): string {
  return `${config.sync.tagPrefix}:${book.source_id}`;
}

export function formatSeries(name: string, sequence: string | null): string {
  const trimmed = sequence?.trim();
  return trimmed ? `${name} #${trimmed}` : name;
}

/** The metadata we would like Audiobookshelf to end up with for this book. */
export function buildSidecar(book: BookWithPeople, config: Config): Sidecar {
  const sidecar: Sidecar = {};

  if (book.title) sidecar.title = book.title;
  if (book.subtitle) sidecar.subtitle = book.subtitle;
  if (book.authors.length) sidecar.authors = book.authors;
  if (book.narrators.length) sidecar.narrators = book.narrators;
  if (book.series_name) sidecar.series = [formatSeries(book.series_name, book.series_seq)];
  if (book.genres.length) sidecar.genres = book.genres;
  if (book.description) sidecar.description = book.description;
  if (book.published_year) sidecar.publishedYear = book.published_year;
  if (book.isbn) sidecar.isbn = book.isbn;
  if (book.asin) sidecar.asin = book.asin;
  if (config.sync.language) sidecar.language = config.sync.language;

  // The marker tag lets us re-identify the item on later runs without fuzzy matching.
  const tags = new Set(book.tags);
  tags.add(sourceTag(book, config));
  sidecar.tags = [...tags];

  return sidecar;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const a = [...left].map(String).sort();
    const b = [...right].map(String).sort();
    return a.every((value, index) => value === b[index]);
  }
  if (typeof left === "string" && typeof right === "string") return left.trim() === right.trim();
  return left === right;
}

/** Current state of the item as Audiobookshelf reports it, in sidecar shape. */
export function itemToSidecar(item: AbsItem): Sidecar {
  const sidecar: Sidecar = {
    title: item.title || undefined,
    subtitle: item.subtitle ?? undefined,
    authors: item.authors.length ? item.authors : undefined,
    narrators: item.narrators.length ? item.narrators : undefined,
    series: item.series.length ? item.series : undefined,
    genres: item.genres.length ? item.genres : undefined,
    tags: item.tags.length ? item.tags : undefined,
    description: item.description ?? undefined,
    publishedYear: item.publishedYear ?? undefined,
    language: item.language ?? undefined,
    isbn: item.isbn ?? undefined,
    asin: item.asin ?? undefined,
  };
  return sidecar;
}

export interface ReconcileResult {
  payload: Sidecar;
  changed: boolean;
  changedFields: string[];
  skippedFields: string[];
}

/**
 * Merge our desired metadata with what is already in the library, honouring the write policy.
 *
 * `overwrite-ours` is the interesting one: a field is only replaced when the library still
 * holds the value we last wrote (or nothing at all). If somebody edited it in the
 * Audiobookshelf UI, their value stays.
 */
export function reconcileSidecar(
  desired: Sidecar,
  current: Sidecar | null,
  previous: Sidecar | null,
  policy: Config["sync"]["writePolicy"],
): ReconcileResult {
  const payload: Sidecar = {};
  const changedFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of SIDECAR_FIELDS) {
    const wanted = desired[field];
    const existing = current?.[field];
    const ours = previous?.[field];

    if (isEmpty(wanted)) {
      // Never blank out a field we have nothing better for.
      if (!isEmpty(existing)) payload[field] = existing as never;
      continue;
    }

    let write: boolean;
    switch (policy) {
      case "overwrite-all":
        write = true;
        break;
      case "fill-empty":
        write = isEmpty(existing);
        break;
      case "overwrite-ours":
        write = isEmpty(existing) || ours === undefined || sameValue(existing, ours);
        break;
    }

    if (write) {
      payload[field] = wanted as never;
      if (!sameValue(existing, wanted)) changedFields.push(field);
    } else {
      payload[field] = existing as never;
      skippedFields.push(field);
    }
  }

  // The marker tag is bookkeeping and must survive whatever the policy decided.
  const markerSource = desired.tags ?? [];
  if (markerSource.length > 0) {
    const tags = new Set([...(payload.tags ?? []), ...markerSource]);
    const merged = [...tags];
    if (!sameValue(payload.tags, merged)) {
      payload.tags = merged;
      if (!changedFields.includes("tags") && !sameValue(current?.tags, merged)) changedFields.push("tags");
    }
  }

  return { payload, changed: changedFields.length > 0, changedFields, skippedFields };
}

export function sidecarHash(sidecar: Sidecar): string {
  const ordered: Record<string, unknown> = {};
  for (const field of [...SIDECAR_FIELDS].sort()) {
    const value = sidecar[field];
    if (value === undefined) continue;
    ordered[field] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return Bun.hash(JSON.stringify(ordered)).toString(16);
}

export function serialiseSidecar(sidecar: Sidecar): string {
  // Two-space indent matches what Audiobookshelf itself writes, keeping diffs readable.
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}
