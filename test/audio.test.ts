import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.ts";
import {
  ensureAudioFromPlaylist,
  parseM3u,
  playlistUrlFor,
  trackFileName,
} from "../src/audio/m3u.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.stop(true);
  }
});

function book(partial: Partial<BookWithPeople> = {}): BookWithPeople {
  return {
    source_id: 6840,
    url: "https://4read.org/6840-x.html",
    slug: "mskingbean89-vsi-molodi-chuvaki-pershij-rik",
    title: "Всі молоді чуваки: Перший рік",
    subtitle: null,
    description: null,
    cover_url: null,
    duration_sec: null,
    rating: null,
    votes: null,
    series_key: null,
    series_name: null,
    series_seq: null,
    published_year: null,
    lastmod: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    fetched_at: null,
    content_hash: null,
    work_key: null,
    work_label: null,
    isbn: null,
    asin: null,
    hardcover_book_id: null,
    hardcover_slug: null,
    hardcover_cover_url: null,
    hardcover_series_id: null,
    hardcover_match_kind: null,
    detail_state: "ok",
    detail_error: null,
    authors: ["MsKingBean89"],
    narrators: [],
    genres: [],
    tags: [],
    ...partial,
  };
}

describe("M3U parsing", () => {
  test("reads EXTINF titles and bare URLs in order", () => {
    const tracks = parseM3u(`#EXTM3U
#EXTINF:-1,Chapter One
https://cdn.example/a.mp3
#EXTINF:-1,Chapter Two
https://cdn.example/b.mp3
https://cdn.example/c.mp3
`);
    expect(tracks.map((t) => t.url)).toEqual([
      "https://cdn.example/a.mp3",
      "https://cdn.example/b.mp3",
      "https://cdn.example/c.mp3",
    ]);
    expect(tracks[0]!.title).toBe("Chapter One");
    expect(tracks[2]!.title).toBeNull();
  });

  test("resolves relative track URLs against the playlist", () => {
    const tracks = parseM3u("files/1.mp3\nfiles/2.mp3\n", "http://backend.local/m33u2/book.m3u");
    expect(tracks[0]!.url).toBe("http://backend.local/m33u2/files/1.mp3");
  });

  test("builds the playlist URL from DOWNLOAD_BASE and slug", () => {
    const config = configSchema.parse({ audio: { downloadBase: "http://audio.local/" } });
    expect(playlistUrlFor(book(), config)).toBe(
      "http://audio.local/m33u2/mskingbean89-vsi-molodi-chuvaki-pershij-rik.m3u",
    );
  });

  test("trackFileName uses 4-digit index and path basename, strips query", () => {
    expect(
      trackFileName(0, {
        url: "https://cdn.example/path/Chapter%20One.mp3?sig=abc&exp=1",
        title: "Ignored Title",
      }),
    ).toBe("0001-Chapter One.mp3");
    expect(trackFileName(9, { url: "https://cdn.example/z.ogg#frag", title: null })).toBe(
      "0010-z.ogg",
    );
    expect(trackFileName(0, { url: "https://cdn.example/noext?x=1", title: "Fallback" })).toBe(
      "0001-noext.mp3",
    );
    expect(trackFileName(0, { url: "https://cdn.example/", title: null })).toBe("0001-track-0001.mp3");
  });
});

describe("playlist audio fetch", () => {
  test("downloads ordered mp3s into the staging folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-"));
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);

    try {
      const origin = Bun.serve({
        port: 0,
        fetch(request): Response {
          const { pathname } = new URL(request.url);
          if (pathname.endsWith(".m3u")) {
            const base = `http://127.0.0.1:${origin.port}`;
            return new Response(
              `#EXTM3U\n#EXTINF:-1,Part A\n${base}/folder/a.mp3?token=1\n#EXTINF:-1,Part B\n${base}/b.mp3?sig=xyz\n`,
              { headers: { "content-type": "audio/x-mpegurl" } },
            );
          }
          if (pathname.endsWith(".mp3")) {
            return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
          }
          return new Response("no", { status: 404 });
        },
      });
      servers.push(origin);

      const config = configSchema.parse({
        audio: { downloadBase: `http://127.0.0.1:${origin.port}` },
      });
      const target = join(dir, "book");
      const result = await ensureAudioFromPlaylist(book(), target, config);

      expect(result?.tracks).toBe(2);
      expect(result?.downloaded).toBe(2);
      const names = (await readdir(target)).filter((n) => n.endsWith(".mp3")).sort();
      expect(names).toEqual(["0001-a.mp3", "0002-b.mp3"]);
      expect(await readFile(join(target, ".4read-audio-playlist"), "utf8")).toContain("/m33u2/");

      // Second run is a no-op.
      const again = await ensureAudioFromPlaylist(book(), target, config);
      expect(again?.downloaded).toBe(0);
      expect(again?.skipped).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
