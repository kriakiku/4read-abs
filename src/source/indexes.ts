import * as cheerio from "cheerio";
import { DEFAULT_BASE_URL, parseXfsearchKey, type XfKind } from "./urls.ts";

export interface IndexEntry {
  key: string;
  name: string;
  bookCount: number | null;
}

/**
 * `avtors.html` and `readers.html` list every author / narrator with a book count, so the
 * whole entity space can be seeded from two requests. Link labels look like
 * "Агата Крісті - 27 книг".
 */
export function parseEntityIndex(html: string, kind: XfKind, base = DEFAULT_BASE_URL): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries = new Map<string, IndexEntry>();

  $(`a[href*="/xfsearch/${kind}/"]`).each((_, element) => {
    const anchor = $(element);
    const key = parseXfsearchKey(anchor.attr("href"), kind, base);
    if (!key) return;

    const label = anchor.text().replace(/\s+/g, " ").trim();
    if (!label) return;

    const countMatch = /\s[-–—]\s(\d+)\s+\S+\s*$/.exec(label);
    const bookCount = countMatch ? Number.parseInt(countMatch[1]!, 10) : null;
    const name = countMatch ? label.slice(0, countMatch.index).trim() : label;
    if (!name) return;

    const existing = entries.get(key);
    if (!existing || (existing.bookCount === null && bookCount !== null)) {
      entries.set(key, { key, name, bookCount });
    }
  });

  return [...entries.values()];
}
