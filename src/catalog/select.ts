import type { Config } from "../config.ts";
import { normaliseName } from "./normalize.ts";
import type { BookWithPeople } from "./store.ts";

export interface EditionScore {
  book: BookWithPeople;
  score: number;
  blocked: boolean;
  preferredNarrator: string | null;
  reasons: string[];
}

function narratorIndex(prefer: string[], narrators: string[]): number {
  const wanted = prefer.map((name) => normaliseName(name));
  const have = narrators.map((name) => normaliseName(name));
  for (let index = 0; index < wanted.length; index += 1) {
    const target = wanted[index]!;
    if (have.some((name) => name === target || name.includes(target) || target.includes(name))) return index;
  }
  return -1;
}

/**
 * Ranks one reading of a book. Narrator preference dominates on purpose: a favourite
 * narrator should win even over a better rated alternative. Ratings only break ties.
 */
export function scoreEdition(book: BookWithPeople, config: Config): EditionScore {
  const reasons: string[] = [];
  const prefer = config.narrators.prefer;
  const blockIndex = narratorIndex(config.narrators.block, book.narrators);
  const preferIdx = narratorIndex(prefer, book.narrators);

  let score = 0;
  const blocked = blockIndex >= 0;
  if (blocked) {
    score -= 1_000_000;
    reasons.push(`narrator blocked (${book.narrators.join(", ")})`);
  }

  let preferredNarrator: string | null = null;
  if (preferIdx >= 0) {
    score += 10_000 * (prefer.length - preferIdx);
    preferredNarrator = prefer[preferIdx] ?? null;
    reasons.push(`preferred narrator #${preferIdx + 1}: ${preferredNarrator}`);
  }

  // Votes damp the rating so a lone 5-star vote does not beat a well rated alternative.
  if (book.rating !== null) {
    const confidence = Math.min(book.votes ?? 0, 50) / 50;
    const ratingPoints = book.rating * (0.3 + 0.7 * confidence) * 20;
    score += ratingPoints;
    reasons.push(`rating ${book.rating} (${book.votes ?? 0} votes)`);
  }

  if (book.series_key) score += 5;
  if (book.duration_sec) score += 3;
  if (book.description) score += 2;
  if (book.narrators.length > 0) score += 2;
  if (book.detail_state === "ok") score += 5;

  return { book, score, blocked, preferredNarrator, reasons };
}

/**
 * Collapse several readings of the same work down to one. Blocked narrations are dropped
 * entirely unless nothing else is available.
 */
export function pickBestEdition(books: BookWithPeople[], config: Config): EditionScore | null {
  if (books.length === 0) return null;
  const scored = books.map((book) => scoreEdition(book, config));
  const allowed = scored.filter((entry) => !entry.blocked);
  const pool = allowed.length > 0 ? allowed : scored;
  return pool.reduce((best, entry) => {
    if (entry.score > best.score) return entry;
    // Deterministic tie-break so repeated runs agree.
    if (entry.score === best.score && entry.book.source_id > best.book.source_id) return entry;
    return best;
  }, pool[0]!);
}

export interface WorkGroup {
  workKey: string;
  best: EditionScore;
  alternatives: EditionScore[];
}

/** Group by work identity and choose a winner per group. */
export function groupByWork(books: BookWithPeople[], config: Config): WorkGroup[] {
  const groups = new Map<string, BookWithPeople[]>();
  for (const book of books) {
    // Books without a parsed work key are kept separate so they are never merged blindly.
    const key = book.work_key ?? `unkeyed:${book.source_id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(book);
    else groups.set(key, [book]);
  }

  const result: WorkGroup[] = [];
  for (const [workKey, bucket] of groups) {
    const best = pickBestEdition(bucket, config);
    if (!best) continue;
    result.push({
      workKey,
      best,
      alternatives: bucket
        .filter((book) => book.source_id !== best.book.source_id)
        .map((book) => scoreEdition(book, config))
        .sort((a, b) => b.score - a.score),
    });
  }
  return result;
}
