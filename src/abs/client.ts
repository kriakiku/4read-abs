import { logger } from "../log.ts";

const log = logger("abs");

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
}

export interface AbsItem {
  id: string;
  libraryId: string;
  path: string;
  relPath: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  series: string[];
  genres: string[];
  tags: string[];
  description: string | null;
  asin: string | null;
  isbn: string | null;
  language: string | null;
  publishedYear: string | null;
  numAudioFiles: number | null;
}

interface RawMetadata {
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  asin?: string | null;
  isbn?: string | null;
  language?: string | null;
  publishedYear?: string | null;
  genres?: string[] | null;
  authors?: Array<{ name?: string } | string> | null;
  narrators?: string[] | null;
  series?: Array<{ name?: string; sequence?: string | null } | string> | null;
  authorName?: string | null;
  narratorName?: string | null;
  seriesName?: string | null;
}

interface RawItem {
  id: string;
  libraryId: string;
  path?: string;
  relPath?: string;
  numFiles?: number;
  media?: {
    metadata?: RawMetadata;
    tags?: string[] | null;
    numAudioFiles?: number;
    audioFiles?: unknown[];
  };
}

function splitNames(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s*(?:,|&|;)\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** ABS returns either expanded objects or the minified `*Name` strings depending on the route. */
function normaliseItem(raw: RawItem): AbsItem {
  const metadata = raw.media?.metadata ?? {};

  const authors = Array.isArray(metadata.authors)
    ? metadata.authors
        .map((author) => (typeof author === "string" ? author : (author?.name ?? "")))
        .filter(Boolean)
    : splitNames(metadata.authorName);

  const narrators = Array.isArray(metadata.narrators)
    ? metadata.narrators.filter(Boolean)
    : splitNames(metadata.narratorName);

  const series = Array.isArray(metadata.series)
    ? metadata.series
        .map((entry) => (typeof entry === "string" ? entry : (entry?.name ?? "")))
        .filter(Boolean)
    : splitNames(metadata.seriesName);

  return {
    id: raw.id,
    libraryId: raw.libraryId,
    path: raw.path ?? "",
    relPath: raw.relPath ?? "",
    title: metadata.title ?? "",
    subtitle: metadata.subtitle ?? null,
    authors,
    narrators,
    series,
    genres: Array.isArray(metadata.genres) ? metadata.genres.filter(Boolean) : [],
    tags: Array.isArray(raw.media?.tags) ? raw.media!.tags!.filter(Boolean) : [],
    description: metadata.description ?? null,
    asin: metadata.asin ?? null,
    isbn: metadata.isbn ?? null,
    language: metadata.language ?? null,
    publishedYear: metadata.publishedYear ?? null,
    numAudioFiles: raw.media?.numAudioFiles ?? raw.media?.audioFiles?.length ?? null,
  };
}

export class AudiobookshelfClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  get configured(): boolean {
    return this.baseUrl.length > 0 && this.apiKey.length > 0;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) throw new Error("Audiobookshelf is not configured (set ABS_URL and ABS_API_KEY)");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ABS ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<{ success?: boolean }>("/api/ping");
      return true;
    } catch (error) {
      log.warn(`ping failed: ${String(error)}`);
      return false;
    }
  }

  async libraries(): Promise<AbsLibrary[]> {
    const data = await this.request<{ libraries: AbsLibrary[] }>("/api/libraries");
    return (data.libraries ?? []).map((library) => ({
      id: library.id,
      name: library.name,
      mediaType: library.mediaType,
    }));
  }

  async bookLibraries(only: string[] = []): Promise<AbsLibrary[]> {
    const all = await this.libraries();
    const books = all.filter((library) => library.mediaType === "book");
    if (only.length === 0) return books;
    return books.filter((library) => only.includes(library.id));
  }

  /** Every item in a library, paged. Libraries can be large so this walks pages. */
  async items(libraryId: string, pageSize = 200): Promise<AbsItem[]> {
    const collected: AbsItem[] = [];
    let page = 0;
    for (;;) {
      const data = await this.request<{ results?: RawItem[]; total?: number }>(
        `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${pageSize}&page=${page}`,
      );
      const results = data.results ?? [];
      collected.push(...results.map(normaliseItem));
      if (results.length < pageSize) break;
      page += 1;
      if (page > 500) break;
    }
    return collected;
  }

  async item(itemId: string): Promise<AbsItem> {
    const raw = await this.request<RawItem>(`/api/items/${encodeURIComponent(itemId)}?expanded=1`);
    return normaliseItem(raw);
  }

  /** Rescan a single item so a freshly written sidecar is picked up immediately. */
  async scanItem(itemId: string): Promise<string | null> {
    try {
      const result = await this.request<{ result?: string }>(`/api/items/${encodeURIComponent(itemId)}/scan`, {
        method: "POST",
      });
      return result?.result ?? null;
    } catch (error) {
      log.warn(`item scan failed for ${itemId}: ${String(error)}`);
      return null;
    }
  }

  async scanLibrary(libraryId: string): Promise<void> {
    await this.request(`/api/libraries/${encodeURIComponent(libraryId)}/scan`, { method: "POST" });
  }

  /** Writes tags into the audio files themselves. Destructive, so callers must opt in. */
  async embedMetadata(itemId: string, backup = true): Promise<void> {
    await this.request(
      `/api/tools/item/${encodeURIComponent(itemId)}/embed-metadata?backup=${backup ? 1 : 0}`,
      { method: "POST" },
    );
  }
}
