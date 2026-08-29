export const DEFAULT_BASE_URL = "https://4read.org";

/** Paths that look like categories but are site features. */
const NON_CATEGORY_SEGMENTS = new Set([
  "blog",
  "tags",
  "xfsearch",
  "user",
  "index.php",
  "engine",
  "uploads",
  "templates",
  "m3u",
  "bed",
  "readers.html",
  "avtors.html",
  "top-100.html",
  "sitemap.xml",
  "rss.xml",
]);

export function absoluteUrl(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${base}/`).toString();
  } catch {
    return null;
  }
}

export interface BookRef {
  sourceId: number;
  slug: string;
  url: string;
}

/** Article URLs are `/<id>-<slug>.html`; blog posts share the shape so callers must verify content. */
export function parseBookUrl(href: string | undefined, base = DEFAULT_BASE_URL): BookRef | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/(\d+)-([^/]*)\.html$/.exec(path);
  if (!match) return null;
  const sourceId = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(sourceId)) return null;
  return { sourceId, slug: match[2] ?? "", url };
}

export type XfKind = "avtor" | "chitaet" | "cikl";

/**
 * The site's own facet URLs double as stable identifiers: `/xfsearch/avtor/<name>/`.
 * The decoded segment is used verbatim as our key.
 */
export function parseXfsearchKey(href: string | undefined, kind: XfKind, base = DEFAULT_BASE_URL): string | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const prefix = `/xfsearch/${kind}/`;
  if (!path.startsWith(prefix)) return null;
  const raw = path.slice(prefix.length).replace(/\/+$/, "");
  if (!raw) return null;
  return normaliseKey(raw);
}

export function parseTagKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith("/tags/")) return null;
  const raw = path.slice("/tags/".length).replace(/\/+$/, "");
  return raw ? normaliseKey(raw) : null;
}

/** Genre links are single-segment category paths such as `/fentezi/`. */
export function parseCategoryKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const segment = segments[0]!;
  if (segment.endsWith(".html") || segment.endsWith(".xml")) return null;
  if (NON_CATEGORY_SEGMENTS.has(segment)) return null;
  return normaliseKey(segment);
}

function normaliseKey(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Leave malformed escapes as-is rather than dropping the entity.
  }
  return decoded.replace(/\s+/g, " ").trim().toLowerCase();
}

export function xfsearchUrl(kind: XfKind, key: string, page = 1, base = DEFAULT_BASE_URL): string {
  const encoded = encodeURIComponent(key);
  const suffix = page > 1 ? `page/${page}/` : "";
  return `${base}/xfsearch/${kind}/${encoded}/${suffix}`;
}

export function categoryUrl(key: string, page = 1, base = DEFAULT_BASE_URL): string {
  const suffix = page > 1 ? `page/${page}/` : "";
  return `${base}/${key}/${suffix}`;
}

export function bookUrl(sourceId: number, slug: string, base = DEFAULT_BASE_URL): string {
  return `${base}/${sourceId}-${slug}.html`;
}

/** `05:28:52` or `1:02` into seconds. */
export function parseDurationToSeconds(value: string | undefined | null): number | null {
  if (!value) return null;
  const parts = value.trim().split(":").map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (part as number);
  return seconds > 0 ? seconds : null;
}
