import * as cheerio from "cheerio";
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  parseBookUrl,
  parseDurationToSeconds,
} from "./urls.ts";

export interface ListingCard {
  sourceId: number;
  url: string;
  slug: string;
  title: string;
  authorName: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  rating: number | null;
  votes: number | null;
}

export interface ListingPage {
  cards: ListingCard[];
  /** Highest page number advertised by the pager, 1 when there is no pager. */
  lastPage: number;
}

/**
 * Parse a grid of book cards. Used for category pages and for the `xfsearch` facet pages,
 * which share the same markup. Only the main grid is considered so sidebar carousels and
 * "you might also like" blocks do not leak in.
 */
export function parseListingPage(html: string, base = DEFAULT_BASE_URL): ListingPage {
  const $ = cheerio.load(html);
  const cards: ListingCard[] = [];
  const seen = new Set<number>();

  $(".grid-items .poster").each((_, element) => {
    const card = $(element);
    const ref = parseBookUrl(card.find("a.poster__link").attr("href"), base);
    if (!ref || seen.has(ref.sourceId)) return;

    const title = card.find(".poster__title").first().text().trim();
    if (!title) return;
    seen.add(ref.sourceId);

    const authorName = card.find(".poster__subtitle").first().text().trim() || null;
    const durationSec = parseDurationToSeconds(card.find(".js-duration").attr("data-time"));
    const votesRaw = card.find("[data-vote-num-id]").first().text().trim();
    const votes = votesRaw ? Number.parseInt(votesRaw, 10) : Number.NaN;

    // "Рейтинг 4.5 (18 голосів)"
    const ratingText = card.find(".poster__ratings").first().text().replace(/\s+/g, " ");
    const ratingMatch = /(\d+(?:[.,]\d+)?)\s*\(/.exec(ratingText);
    const rating = ratingMatch ? Number.parseFloat(ratingMatch[1]!.replace(",", ".")) : Number.NaN;

    cards.push({
      sourceId: ref.sourceId,
      url: ref.url,
      slug: ref.slug,
      title,
      authorName,
      coverUrl: absoluteUrl(card.find(".poster__img img").attr("src"), base),
      durationSec,
      rating: Number.isFinite(rating) ? rating : null,
      votes: Number.isFinite(votes) ? votes : null,
    });
  });

  let lastPage = 1;
  $(".pagination a[href*='/page/']").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    const match = /\/page\/(\d+)\//.exec(href);
    if (match) lastPage = Math.max(lastPage, Number.parseInt(match[1]!, 10));
  });
  $(".pagination span").each((_, element) => {
    const value = Number.parseInt($(element).text().trim(), 10);
    if (Number.isFinite(value)) lastPage = Math.max(lastPage, value);
  });

  return { cards, lastPage };
}
