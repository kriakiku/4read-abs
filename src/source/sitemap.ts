import { DEFAULT_BASE_URL, parseBookUrl } from "./urls.ts";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface SitemapBookEntry extends SitemapEntry {
  sourceId: number;
  slug: string;
}

function extractTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match) return null;
  return match[1]!.trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() || null;
}

/**
 * A tolerant sitemap reader. XML here is machine generated and simple, so regex extraction
 * avoids pulling in an XML parser and copes with the occasional stray entity.
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const match of xml.matchAll(/<(?:url|sitemap)\b[\s\S]*?<\/(?:url|sitemap)>/gi)) {
    const block = match[0];
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    entries.push({ loc, lastmod: extractTag(block, "lastmod") });
  }
  return entries;
}

/** Sub-sitemap URLs from the top level `sitemap.xml` index. */
export function parseSitemapIndex(xml: string): string[] {
  return parseSitemap(xml).map((entry) => entry.loc);
}

/**
 * 4read's index lists category/tags/static sitemaps alongside `news_pages.xml`.
 * Only the news sitemap carries article URLs; the others waste FlareSolverr budget
 * (and previously matched a naive `/page/` filter).
 */
export function isArticleSitemapUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /(^|\/)news_pages\.xml$/.test(path) || /(^|\/)news[_-]pages\.xml$/.test(path);
  } catch {
    return /news_pages\.xml(?:$|\?)/i.test(url);
  }
}

/** Only the entries that look like article pages, with their `lastmod` for change detection. */
export function parseBookSitemap(xml: string, base = DEFAULT_BASE_URL): SitemapBookEntry[] {
  const books = new Map<number, SitemapBookEntry>();
  for (const entry of parseSitemap(xml)) {
    const ref = parseBookUrl(entry.loc, base);
    if (!ref) continue;
    const existing = books.get(ref.sourceId);
    if (existing && (existing.lastmod ?? "") >= (entry.lastmod ?? "")) continue;
    books.set(ref.sourceId, {
      loc: ref.url,
      lastmod: entry.lastmod,
      sourceId: ref.sourceId,
      slug: ref.slug,
    });
  }
  return [...books.values()];
}

export function sitemapIndexUrl(base = DEFAULT_BASE_URL): string {
  return `${base}/sitemap.xml`;
}
