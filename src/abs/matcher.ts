import type { Config } from "../config.ts";
import { matchScore } from "../catalog/normalize.ts";
import { withPeople, type BookRow, type BookWithPeople } from "../catalog/store.ts";
import { nowIso, type Db } from "../db.ts";
import { logger } from "../log.ts";
import type { AbsItem } from "./client.ts";
import type { Sidecar } from "./metadata.ts";

const log = logger("matcher");

export interface AbsLink {
  source_id: number;
  abs_item_id: string;
  abs_library_id: string | null;
  abs_path: string | null;
  written_hash: string | null;
  written_payload: string | null;
  written_at: string | null;
  pinned: number;
  confidence: number | null;
}

export function getLinkByItem(db: Db, itemId: string): AbsLink | null {
  return db.query<AbsLink, [string]>("select * from abs_links where abs_item_id = ?").get(itemId) ?? null;
}

export function getLinkBySource(db: Db, sourceId: number): AbsLink | null {
  return db.query<AbsLink, [number]>("select * from abs_links where source_id = ?").get(sourceId) ?? null;
}

export function saveLink(
  db: Db,
  link: {
    sourceId: number;
    itemId: string;
    libraryId?: string | null;
    path?: string | null;
    confidence?: number | null;
    pinned?: boolean;
  },
): void {
  db.query(
    `insert into abs_links (source_id, abs_item_id, abs_library_id, abs_path, confidence, pinned)
     values (?, ?, ?, ?, ?, ?)
     on conflict(source_id, abs_item_id) do update set
       abs_library_id = coalesce(excluded.abs_library_id, abs_links.abs_library_id),
       abs_path = coalesce(excluded.abs_path, abs_links.abs_path),
       confidence = coalesce(excluded.confidence, abs_links.confidence),
       pinned = max(excluded.pinned, abs_links.pinned)`,
  ).run(
    link.sourceId,
    link.itemId,
    link.libraryId ?? null,
    link.path ?? null,
    link.confidence ?? null,
    link.pinned ? 1 : 0,
  );
}

export function recordWrite(db: Db, sourceId: number, itemId: string, payload: Sidecar, hash: string): void {
  db.query(
    "update abs_links set written_hash = ?, written_payload = ?, written_at = ? where source_id = ? and abs_item_id = ?",
  ).run(hash, JSON.stringify(payload), nowIso(), sourceId, itemId);
}

export function previousPayload(link: AbsLink | null): Sidecar | null {
  if (!link?.written_payload) return null;
  try {
    return JSON.parse(link.written_payload) as Sidecar;
  } catch {
    return null;
  }
}

export function removeLink(db: Db, itemId: string): void {
  db.query("delete from abs_links where abs_item_id = ?").run(itemId);
}

export function removeLinkBySource(db: Db, sourceId: number): void {
  db.query("delete from abs_links where source_id = ?").run(sourceId);
}

export interface MatchCandidate {
  book: BookWithPeople;
  score: number;
}

export interface MatchOutcome {
  item: AbsItem;
  book: BookWithPeople | null;
  score: number;
  via: "tag" | "existing-link" | "fuzzy" | "none";
  candidates: MatchCandidate[];
}

/** `4read:6840` embedded in the item's tags is an exact identifier we wrote ourselves. */
function sourceIdFromTags(item: AbsItem, config: Config): number | null {
  const prefix = `${config.sync.tagPrefix}:`.toLowerCase();
  for (const tag of item.tags) {
    const lower = tag.trim().toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const value = Number.parseInt(lower.slice(prefix.length), 10);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Resolve which source book an Audiobookshelf item corresponds to. Exact identifiers are
 * tried first; fuzzy title/author matching only applies above the configured threshold, and
 * anything below it is surfaced in the UI for a human decision instead of guessed at.
 */
export function matchItem(db: Db, item: AbsItem, config: Config): MatchOutcome {
  const existing = getLinkByItem(db, item.id);
  if (existing) {
    const row = db.query<BookRow, [number]>("select * from books where source_id = ?").get(existing.source_id);
    if (row) {
      return {
        item,
        book: withPeople(db, row),
        score: existing.confidence ?? 1,
        via: existing.pinned ? "existing-link" : "existing-link",
        candidates: [],
      };
    }
  }

  const tagged = sourceIdFromTags(item, config);
  if (tagged !== null) {
    const row = db.query<BookRow, [number]>("select * from books where source_id = ?").get(tagged);
    if (row) return { item, book: withPeople(db, row), score: 1, via: "tag", candidates: [] };
    log.debug(`item ${item.id} carries tag for unknown book ${tagged}`);
  }

  if (!item.title) return { item, book: null, score: 0, via: "none", candidates: [] };

  // Narrow with SQL before scoring: comparing against the whole catalogue would be wasteful.
  const rows = candidateRows(db, item);
  const scored: MatchCandidate[] = rows
    .map((row) => {
      const book = withPeople(db, row);
      return {
        book,
        score: matchScore({ title: item.title, authors: item.authors }, { title: book.title, authors: book.authors }),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const best = scored[0];
  if (best && best.score >= config.sync.matchThreshold) {
    return { item, book: best.book, score: best.score, via: "fuzzy", candidates: scored };
  }
  return { item, book: null, score: best?.score ?? 0, via: "none", candidates: scored };
}

function candidateRows(db: Db, item: AbsItem): BookRow[] {
  const tokens = item.title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4)
    .slice(0, 4);

  const rows = new Map<number, BookRow>();

  for (const token of tokens) {
    const matches = db
      .query<BookRow, [string]>("select * from books where detail_state = 'ok' and lower(title) like ?1 limit 80")
      .all(`%${token}%`);
    for (const row of matches) rows.set(row.source_id, row);
  }

  for (const author of item.authors.slice(0, 2)) {
    const matches = db
      .query<BookRow, [string]>(
        `select b.* from books b
         join book_authors ba on ba.source_id = b.source_id
         join authors a on a.key = ba.author_key
         where b.detail_state = 'ok' and lower(a.name) like ?1 limit 120`,
      )
      .all(`%${author.toLowerCase()}%`);
    for (const row of matches) rows.set(row.source_id, row);
  }

  return [...rows.values()];
}
