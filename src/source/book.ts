import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { htmlToText, stripNoiseLines } from "./html.ts";
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  parseBookUrl,
  parseCategoryKey,
  parseDurationToSeconds,
  parseTagKey,
  parseXfsearchKey,
} from "./urls.ts";

export interface NamedRef {
  key: string;
  name: string;
}

export interface ParsedBook {
  sourceId: number;
  url: string;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  rating: number | null;
  votes: number | null;
  authors: NamedRef[];
  narrators: NamedRef[];
  genres: NamedRef[];
  series: (NamedRef & { sequence: string | null }) | null;
  tags: string[];
  /** Sibling books linked from the "all parts of the series" block. */
  relatedBookIds: number[];
}

function metaContent($: CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = $(selector).attr("content");
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * `og:title` carries the per-volume title (the `h1` sometimes drops the volume suffix), but
 * it is suffixed with the site name.
 */
function extractTitle($: CheerioAPI): string {
  const siteName = metaContent($, ['meta[property="og:site_name"]']);
  const ogTitle = metaContent($, ['meta[property="og:title"]', 'meta[property="twitter:title"]']);
  if (ogTitle) {
    let title = ogTitle;
    if (siteName && title.endsWith(` - ${siteName}`)) {
      title = title.slice(0, -(siteName.length + 3));
    }
    title = title.replace(/\s*-\s*АудіоКниги Українською$/i, "");
    if (title.trim()) return title.trim();
  }
  // Fallback: "Аудіокнига <title> - автор <author>"
  const h1 = $("h1").first().text().trim();
  return h1
    .replace(/^Аудіокнига\s+/i, "")
    .replace(/\s+-\s+автор\s+.*$/i, "")
    .trim();
}

function findLabelledItem($: CheerioAPI, label: string) {
  return $("ul.pmovie__list > li").filter((_, element) => {
    const text = $(element).children("span").first().text().trim();
    return text.toLowerCase().startsWith(label.toLowerCase());
  });
}

function extractDescription($: CheerioAPI): string | null {
  const container = $('[itemprop="description"]').first();
  if (container.length === 0) return null;

  // Everything from the first heading onward is the series index and support links.
  const clone = container.clone();
  const heading = clone.find("h1, h2, h3").first();
  if (heading.length > 0) {
    heading.nextAll().remove();
    heading.remove();
  }
  clone.find("script, style, .quote, iframe").remove();

  const text = stripNoiseLines(htmlToText($, clone.get(0)));
  return text.length > 0 ? text : null;
}

function extractRating($: CheerioAPI): { rating: number | null; votes: number | null } {
  const scoreText = $(".pmovie__rating-score").first().text().trim().replace(",", ".");
  const rating = scoreText ? Number.parseFloat(scoreText) : Number.NaN;
  const votesText = $("[data-vote-num-id]").first().text().trim();
  const votes = votesText ? Number.parseInt(votesText, 10) : Number.NaN;
  return {
    rating: Number.isFinite(rating) ? rating : null,
    votes: Number.isFinite(votes) ? votes : null,
  };
}

function uniqueByKey(refs: NamedRef[]): NamedRef[] {
  const seen = new Map<string, NamedRef>();
  for (const ref of refs) {
    if (!ref.key || !ref.name) continue;
    if (!seen.has(ref.key)) seen.set(ref.key, ref);
  }
  return [...seen.values()];
}

/**
 * Parse a book article page. Returns null for pages that are not books (the site's blog
 * posts share the same URL shape and appear in the sitemap).
 */
export function parseBookPage(html: string, pageUrl: string, base = DEFAULT_BASE_URL): ParsedBook | null {
  const $ = cheerio.load(html);

  if ($("ul.pmovie__list").length === 0) return null;

  const canonical =
    absoluteUrl($('link[rel="canonical"]').attr("href"), base) ??
    metaContent($, ['meta[property="og:url"]']) ??
    pageUrl;
  const ref = parseBookUrl(canonical, base) ?? parseBookUrl(pageUrl, base);
  if (!ref) return null;

  const title = extractTitle($);
  if (!title) return null;

  const authors: NamedRef[] = [];
  $('[itemprop="author"] a').each((_, element) => {
    const anchor = $(element);
    const key = parseXfsearchKey(anchor.attr("href"), "avtor", base);
    const name = anchor.text().trim();
    if (key && name) authors.push({ key, name });
  });

  const narrators: NamedRef[] = [];
  $('[itemprop="readBy"] a').each((_, element) => {
    const anchor = $(element);
    const key = parseXfsearchKey(anchor.attr("href"), "chitaet", base);
    const name = anchor.text().trim();
    if (key && name) narrators.push({ key, name });
  });

  const genres: NamedRef[] = [];
  findLabelledItem($, "Жанр")
    .find("a")
    .each((_, element) => {
      const anchor = $(element);
      const key = parseCategoryKey(anchor.attr("href"), base);
      const name = anchor.text().trim();
      if (key && name) genres.push({ key, name });
    });

  let series: (NamedRef & { sequence: string | null }) | null = null;
  const seriesItem = $('[itemtype$="PublicationVolume"]').first();
  if (seriesItem.length > 0) {
    const anchor = seriesItem.find('[itemprop="name"] a').first();
    const key = parseXfsearchKey(anchor.attr("href"), "cikl", base);
    const name = anchor.text().trim();
    const sequence = seriesItem.find('[itemprop="volumeNumber"]').first().text().trim();
    if (key && name) series = { key, name, sequence: sequence || null };
  }

  const durationSec =
    parseDurationToSeconds(metaContent($, ['meta[itemprop="duration"]'])) ??
    parseDurationToSeconds(findLabelledItem($, "Трива").first().text().split(":").slice(-3).join(":"));

  const tags = new Set<string>();
  for (const raw of (metaContent($, ['meta[name="news_keywords"]']) ?? "").split(",")) {
    const tag = raw.trim();
    if (tag) tags.add(tag);
  }
  $('a[href*="/tags/"]').each((_, element) => {
    const key = parseTagKey($(element).attr("href"), base);
    const name = $(element).text().trim();
    if (key) tags.add(name || key);
  });

  const relatedBookIds = new Set<number>();
  $('[itemprop="description"]')
    .find("a")
    .each((_, element) => {
      const related = parseBookUrl($(element).attr("href"), base);
      if (related && related.sourceId !== ref.sourceId) relatedBookIds.add(related.sourceId);
    });

  const { rating, votes } = extractRating($);

  return {
    sourceId: ref.sourceId,
    url: ref.url,
    slug: ref.slug,
    title,
    description: extractDescription($),
    coverUrl: absoluteUrl(metaContent($, ['meta[property="og:image"]', 'meta[property="twitter:image"]']), base),
    durationSec: durationSec ?? null,
    rating,
    votes,
    authors: uniqueByKey(authors),
    narrators: uniqueByKey(narrators),
    genres: uniqueByKey(genres),
    series,
    tags: [...tags],
    relatedBookIds: [...relatedBookIds],
  };
}
