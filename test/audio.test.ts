import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import {
  ensureAudioFromPlaylist,
  extractPlaylistBody,
  extractPlaylistFromHar,
  extractPlaylistUrlFromHtml,
  parseM3u,
  playlistUrlFor,
  trackFileName,
} from "../src/audio/m3u.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";
import { Fetcher } from "../src/fetch/fetcher.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const fetchers: Fetcher[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (fetchers.length) {
    const fetcher = fetchers.pop();
    if (fetcher) await fetcher.close();
  }
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.stop(true);
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function book(partial: Partial<BookWithPeople> = {}): BookWithPeople {
  return {
    source_id: 6840,
    url: "https://4read.org/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html",
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

async function makeFetcher(overrides: Record<string, unknown> = {}): Promise<{
  fetcher: Fetcher;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "4read-audio-db-"));
  tempDirs.push(dir);
  const db = openDb(dir);
  const config = configSchema.parse({
    paths: { data: dir },
    source: { minIntervalMs: 0, challengeCooldownMs: 50 },
    flaresolverr: { url: "", mode: "never" },
    ...overrides,
  });
  const fetcher = new Fetcher(db, config);
  fetchers.push(fetcher);
  return { fetcher, dir };
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

  test("builds the playlist URL as /m33u2/{id}-{slug}.m3u", () => {
    const config = configSchema.parse({
      source: { baseUrl: "https://4read.org/" },
    });
    expect(playlistUrlFor(book(), config)).toBe(
      "https://4read.org/m33u2/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.m3u",
    );
    expect(
      playlistUrlFor(
        {
          source_id: 5546,
          slug: "garri-garrison-stalevyj-schur-2025-mp3",
          url: "https://4read.org/5546-garri-garrison-stalevyj-schur-2025-mp3.html",
        },
        config,
      ),
    ).toBe("https://4read.org/m33u2/5546-garri-garrison-stalevyj-schur-2025-mp3.m3u");
  });

  test("returns null when the book has no slug or id", () => {
    const config = configSchema.parse({});
    expect(playlistUrlFor(book({ slug: "", url: "", source_id: 0 }), config)).toBeNull();
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

  test("extractPlaylistUrlFromHtml reads Playerjs file=", () => {
    const html = `<script>var playerjs1 = new Playerjs({id:"playerjs1",file:"https://4read.org/m33u2/5546-garri-garrison-stalevyj-schur-2025-mp3.m3u"});</script>`;
    expect(extractPlaylistUrlFromHtml(html)).toBe(
      "https://4read.org/m33u2/5546-garri-garrison-stalevyj-schur-2025-mp3.m3u",
    );
    expect(
      extractPlaylistUrlFromHtml(`file:"/m33u2/8054-dzhordzh-martin-lishe-za-vchora.m3u"`, "https://4read.org"),
    ).toBe("https://4read.org/m33u2/8054-dzhordzh-martin-lishe-za-vchora.m3u");
  });

  test("extractPlaylistUrlFromHtml prefers URL matching book key", () => {
    const html = `
      <script>new Playerjs({file:"https://4read.org/m33u2/3130-related-book.m3u"});</script>
      <script>new Playerjs({file:"https://4read.org/m33u2/2901-this-book.m3u"});</script>
    `;
    expect(extractPlaylistUrlFromHtml(html, undefined, "2901-this-book")).toBe(
      "https://4read.org/m33u2/2901-this-book.m3u",
    );
  });

  test("extractPlaylistUrlFromHtml returns null when preferKey matches nothing", () => {
    const html = `<script>new Playerjs({file:"https://4read.org/m33u2/3130-other.m3u"});</script>`;
    expect(extractPlaylistUrlFromHtml(html, undefined, "2901-wanted")).toBeNull();
  });

  test("extractPlaylistFromHar returns m33u2 response body", () => {
    const har = {
      log: {
        entries: [
          {
            request: { url: "https://4read.org/m33u2/6840-book.m3u" },
            response: {
              status: 200,
              content: { text: "#EXTM3U\nhttps://cdn.example/a.mp3\n", mimeType: "audio/x-mpegurl" },
            },
          },
        ],
      },
    };
    expect(extractPlaylistFromHar(har)).toEqual({
      url: "https://4read.org/m33u2/6840-book.m3u",
      body: "#EXTM3U\nhttps://cdn.example/a.mp3",
    });
    expect(extractPlaylistFromHar({})).toBeNull();
  });

  test("extractPlaylistBody peels FlareSolverr HTML wrappers", () => {
    const m3u = "#EXTM3U\nhttps://x/a.mp3\n";
    expect(extractPlaylistBody(m3u)).toBe(m3u.trim());
    expect(extractPlaylistBody(`<html><body><pre>${m3u}</pre></body></html>`)).toBe(m3u.trim());
  });

  test("Cloudflare HTML is not treated as an M3U track under /m33u2/", () => {
    const html = `<html dir="ltr" lang="en"><head><title>Just a moment...</title></head><body>cf</body></html>`;
    expect(extractPlaylistBody(html)).toBe("");
    expect(parseM3u(html, "https://4read.org/m33u2/6840-good-slug.m3u")).toEqual([]);
    expect(parseM3u(extractPlaylistBody(html), "https://4read.org/m33u2/6840-good-slug.m3u")).toEqual([]);
  });

  test("playlist key rejects HTML junk and uses id-slug from the book URL", () => {
    const config = configSchema.parse({ source: { baseUrl: "https://4read.org" } });
    expect(
      playlistUrlFor(
        {
          source_id: 6840,
          slug: '<html dir="ltr" lang="en"><head>',
          url: "https://4read.org/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html",
        },
        config,
      ),
    ).toBe("https://4read.org/m33u2/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.m3u");
    expect(
      playlistUrlFor({ source_id: 1, slug: "<html>nope</html>", url: null }, config),
    ).toBeNull();
  });
});

describe("playlist audio fetch", () => {
  test("downloads ordered mp3s into the staging folder via Fetcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);

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

    const { fetcher } = await makeFetcher();
    const config = configSchema.parse({
      source: { baseUrl: `http://127.0.0.1:${origin.port}` },
    });
    const target = join(dir, "book");
    const result = await ensureAudioFromPlaylist(book(), target, config, fetcher);

    expect(result?.tracks).toBe(2);
    expect(result?.downloaded).toBe(2);
    const names = (await readdir(target)).filter((n) => n.endsWith(".mp3")).sort();
    expect(names).toEqual(["0001-a.mp3", "0002-b.mp3"]);
    expect(await readFile(join(target, ".4read-audio-playlist"), "utf8")).toContain("/m33u2/");

    const again = await ensureAudioFromPlaylist(book(), target, config, fetcher);
    expect(again?.downloaded).toBe(0);
    expect(again?.skipped).toBe(2);
  });

  test("playlist warms the book HTML then sends its cookies, Accept, Referer, same UA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-headers-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);
    const seen: Array<{
      path: string;
      accept: string | null;
      referer: string | null;
      cookie: string | null;
      ua: string | null;
    }> = [];

    const origin = Bun.serve({
      port: 0,
      fetch(request): Response {
        const { pathname } = new URL(request.url);
        seen.push({
          path: pathname,
          accept: request.headers.get("accept"),
          referer: request.headers.get("referer"),
          cookie: request.headers.get("cookie"),
          ua: request.headers.get("user-agent"),
        });
        if (pathname.endsWith(".html")) {
          const headers = new Headers({ "content-type": "text/html" });
          headers.append("set-cookie", "PHPSESSID=sess-from-page; Path=/; HttpOnly");
          headers.append("set-cookie", "viewed_ids=6840; Path=/");
          return new Response("<html><body>ok</body></html>", { headers });
        }
        if (pathname.endsWith(".m3u")) {
          const base = `http://127.0.0.1:${origin.port}`;
          return new Response(`#EXTM3U\n${base}/a.mp3\n`, {
            headers: { "content-type": "audio/x-mpegurl" },
          });
        }
        if (pathname.endsWith(".mp3")) {
          return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    servers.push(origin);

    const { fetcher } = await makeFetcher();
    fetcher.jar.set([{ name: "cf_clearance", value: "clear-1" }]);
    fetcher.jar.setUserAgent("TestUA/4read-abs");
    const config = configSchema.parse({
      source: { baseUrl: `http://127.0.0.1:${origin.port}` },
    });
    await ensureAudioFromPlaylist(book(), join(dir, "book"), config, fetcher);

    const htmlReq = seen.find((r) => r.path.endsWith(".html"));
    const playlistReq = seen.find((r) => r.path.endsWith(".m3u"));
    expect(htmlReq).toBeTruthy();
    expect(playlistReq).toBeTruthy();
    expect(seen.findIndex((r) => r.path.endsWith(".html"))).toBeLessThan(
      seen.findIndex((r) => r.path.endsWith(".m3u")),
    );
    expect(playlistReq!.accept).toBe("*/*");
    expect(playlistReq!.referer).toBe(
      `http://127.0.0.1:${origin.port}/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html`,
    );
    expect(playlistReq!.cookie).toContain("cf_clearance=clear-1");
    expect(playlistReq!.cookie).toContain("PHPSESSID=sess-from-page");
    expect(playlistReq!.cookie).toContain("viewed_ids=6840");
    expect(playlistReq!.ua).toBe("TestUA/4read-abs");
    expect(htmlReq!.ua).toBe(playlistReq!.ua);
    expect(fetcher.jar.phpSessionId()).toBe("sess-from-page");
  });

  test("playlist always re-warms the book page before m3u", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-phpsess-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);
    let htmlHits = 0;
    const m3uCookies: string[] = [];

    const origin = Bun.serve({
      port: 0,
      fetch(request): Response {
        const { pathname } = new URL(request.url);
        if (pathname.endsWith(".html")) {
          htmlHits += 1;
          const headers = new Headers({ "content-type": "text/html" });
          headers.append("set-cookie", `PHPSESSID=warm-${htmlHits}; Path=/`);
          headers.append("set-cookie", "viewed_ids=6840; Path=/");
          return new Response("page", { headers });
        }
        if (pathname.endsWith(".m3u")) {
          m3uCookies.push(request.headers.get("cookie") ?? "");
          const base = `http://127.0.0.1:${origin.port}`;
          return new Response(`#EXTM3U\n${base}/a.mp3\n`, {
            headers: { "content-type": "audio/x-mpegurl" },
          });
        }
        if (pathname.endsWith(".mp3")) {
          return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    servers.push(origin);

    const { fetcher } = await makeFetcher();
    fetcher.jar.set([{ name: "PHPSESSID", value: "stale" }]);
    const config = configSchema.parse({
      source: { baseUrl: `http://127.0.0.1:${origin.port}` },
    });
    await ensureAudioFromPlaylist(book(), join(dir, "book"), config, fetcher);
    expect(htmlHits).toBe(1);
    expect(m3uCookies[0]).toContain("PHPSESSID=warm-1");
    expect(m3uCookies[0]).toContain("viewed_ids=6840");
  });

  test("playlist loads via FlareSolverr Chrome, not Bun fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-chrome-m3u-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => (i + 7) % 256);
    const flareRequests: Array<Record<string, unknown>> = [];
    const originHits: string[] = [];

    const origin = Bun.serve({
      port: 0,
      fetch(request): Response {
        originHits.push(new URL(request.url).pathname);
        return new Response("should-not-hit-origin-for-m3u", { status: 500 });
      },
    });
    servers.push(origin);

    const flare = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const payload = (await request.json()) as Record<string, unknown>;
        flareRequests.push(payload);
        if (payload.cmd === "sessions.create") {
          return Response.json({ status: "ok", session: "s1" });
        }
        const target = String(payload.url ?? "");
        const js = String(payload.executeJs ?? "");
        // Track bytes: same-origin executeJs from CDN origin after warmHost.
        if (js.includes("arrayBuffer")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>cdn</body></html>",
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              executeJsResult: Buffer.from(mp3).toString("base64"),
            },
          });
        }
        if (payload.download && target.includes(".mp3")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              download: {
                filename: "a.mp3",
                mime: "audio/mpeg",
                data: Buffer.from(mp3).toString("base64"),
              },
            },
          });
        }
        if (target.includes(".m3u")) {
          const base = `http://127.0.0.1:${origin.port}`;
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: `#EXTM3U\n#EXTINF:-1,A\n${base}/a.mp3?tok=1\n`,
              cookies: [{ name: "PHPSESSID", value: "from-m3u", expires: -1 }],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
            },
          });
        }
        // CDN warm: GET http://host/
        try {
          if (new URL(target).pathname === "/") {
            return Response.json({
              status: "ok",
              solution: {
                url: target,
                status: 200,
                response: "<html><body>cdn root</body></html>",
                cookies: [],
                userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              },
            });
          }
        } catch {
          // continue
        }
        if (target.includes(".html")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: `<html><body><script>new Playerjs({file:"http://127.0.0.1:${origin.port}/m33u2/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.m3u"});</script></body></html>`,
              cookies: [
                { name: "PHPSESSID", value: "from-html", expires: -1 },
                { name: "viewed_ids", value: "6840", expires: -1 },
              ],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              har: {
                log: {
                  entries: [
                    {
                      request: {
                        url: `http://127.0.0.1:${origin.port}/m33u2/6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.m3u`,
                      },
                      response: {
                        status: 200,
                        content: {
                          text: `#EXTM3U\n#EXTINF:-1,A\nhttp://127.0.0.1:${origin.port}/a.mp3?tok=1\n`,
                          mimeType: "audio/x-mpegurl",
                        },
                      },
                    },
                  ],
                },
              },
            },
          });
        }
        return Response.json({ status: "error", message: `unexpected ${target}` });
      },
    });
    servers.push(flare);

    const dbDir = await mkdtemp(join(tmpdir(), "4read-audio-chrome-m3u-db-"));
    tempDirs.push(dbDir);
    const db = openDb(dbDir);
    const config = configSchema.parse({
      paths: { data: dbDir },
      source: {
        baseUrl: `http://127.0.0.1:${origin.port}`,
        minIntervalMs: 0,
        challengeCooldownMs: 50,
        requestTimeoutMs: 5_000,
      },
      flaresolverr: { url: `http://127.0.0.1:${flare.port}/`, mode: "auto", maxTimeoutMs: 5_000 },
    });
    const fetcher = new Fetcher(db, config);
    fetchers.push(fetcher);

    const target = join(dir, "book");
    const result = await ensureAudioFromPlaylist(book(), target, config, fetcher);
    expect(result?.downloaded).toBe(1);
    expect(await readdir(target)).toContain("0001-a.mp3");

    const chromeUrls = flareRequests
      .filter((r) => r.cmd === "request.get")
      .map((r) => String(r.url ?? ""));
    expect(chromeUrls.some((u) => u.includes(".html"))).toBe(true);
    // Playlist came from the page HAR — no separate Chrome GET for .m3u needed.
    expect(chromeUrls.some((u) => u.includes(".m3u"))).toBe(false);
    expect(flareRequests.some((r) => r.recordHar === true)).toBe(true);
    // m3u must not be fetched by Bun against the origin
    expect(originHits.some((p) => p.endsWith(".m3u"))).toBe(false);
    expect(fetcher.jar.phpSessionId()).toBeTruthy();
  });

  test("playlist body from executeJs during book page warm-up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-executejs-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => (i + 3) % 256);
    const flareRequests: Array<Record<string, unknown>> = [];

    const origin = Bun.serve({
      port: 0,
      fetch(request): Response {
        const path = new URL(request.url).pathname;
        if (path.endsWith(".mp3")) return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
        return new Response("nope", { status: 500 });
      },
    });
    servers.push(origin);

    const flare = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const payload = (await request.json()) as Record<string, unknown>;
        flareRequests.push(payload);
        if (payload.cmd === "sessions.create") {
          return Response.json({ status: "ok", session: "s1" });
        }
        const target = String(payload.url ?? "");
        const js = String(payload.executeJs ?? "");
        if (js.includes("arrayBuffer")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>cdn</body></html>",
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              executeJsResult: Buffer.from(mp3).toString("base64"),
            },
          });
        }
        if (target.includes(".html")) {
          const base = `http://127.0.0.1:${origin.port}`;
          expect(js).toContain("m33u2");
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>book</body></html>",
              cookies: [{ name: "PHPSESSID", value: "js", expires: -1 }],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              executeJsResult: `#EXTM3U\n#EXTINF:-1,A\n${base}/a.mp3?tok=1\n`,
            },
          });
        }
        try {
          if (new URL(target).pathname === "/") {
            return Response.json({
              status: "ok",
              solution: {
                url: target,
                status: 200,
                response: "<html><body>cdn root</body></html>",
                cookies: [],
                userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              },
            });
          }
        } catch {
          // continue
        }
        if (payload.download && target.includes(".mp3")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: Buffer.from(mp3).toString("base64"),
              responseEncoding: "base64",
            },
          });
        }
        return Response.json({ status: "error", message: `unexpected ${target}` });
      },
    });
    servers.push(flare);

    const dbDir = await mkdtemp(join(tmpdir(), "4read-audio-executejs-db-"));
    tempDirs.push(dbDir);
    const db = openDb(dbDir);
    const config = configSchema.parse({
      paths: { data: dbDir },
      source: {
        baseUrl: `http://127.0.0.1:${origin.port}`,
        minIntervalMs: 0,
        challengeCooldownMs: 50,
        requestTimeoutMs: 5_000,
      },
      flaresolverr: { url: `http://127.0.0.1:${flare.port}/`, mode: "always", maxTimeoutMs: 5_000 },
    });
    const fetcher = new Fetcher(db, config);
    fetchers.push(fetcher);

    const target = join(dir, "book");
    const result = await ensureAudioFromPlaylist(book(), target, config, fetcher);
    expect(result?.downloaded).toBe(1);
    expect(flareRequests.some((r) => typeof r.executeJs === "string")).toBe(true);
    // No separate m3u download/navigate — body came from executeJs on the HTML request.
    expect(flareRequests.some((r) => String(r.url ?? "").includes(".m3u"))).toBe(false);
  });

  test("falls back to FlareSolverr Chrome download for challenged media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-audio-flare-"));
    tempDirs.push(dir);
    const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => (i + 7) % 256);
    const flareRequests: Array<Record<string, unknown>> = [];

    const origin = Bun.serve({
      port: 0,
      fetch(): Response {
        return new Response("<html>Just a moment...<script>window._cf_chl_opt=1</script></html>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        });
      },
    });
    servers.push(origin);

    const flare = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const payload = (await request.json()) as Record<string, unknown>;
        flareRequests.push(payload);
        if (payload.cmd === "sessions.create") {
          return Response.json({ status: "ok", session: "s1" });
        }
        const target = String(payload.url ?? "");
        const js = String(payload.executeJs ?? "");
        if (js.includes("arrayBuffer")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>cdn</body></html>",
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              executeJsResult: Buffer.from(mp3).toString("base64"),
            },
          });
        }
        if (payload.download && target.includes(".mp3")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              download: {
                filename: "a.mp3",
                mime: "audio/mpeg",
                data: Buffer.from(mp3).toString("base64"),
              },
            },
          });
        }
        if (payload.download && target.includes(".m3u")) {
          const base = `http://127.0.0.1:${origin.port}`;
          const m3u = `#EXTM3U\n#EXTINF:-1,A\n${base}/a.mp3?tok=1\n`;
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              // flaresolverr-go shape
              response: Buffer.from(m3u).toString("base64"),
              responseEncoding: "base64",
            },
          });
        }
        if (target.includes(".m3u")) {
          // Simulate stock Chrome navigate: returns previous HTML page, not the playlist.
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>book page not m3u</body></html>",
              cookies: [],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
            },
          });
        }
        try {
          if (new URL(target).pathname === "/") {
            return Response.json({
              status: "ok",
              solution: {
                url: target,
                status: 200,
                response: "<html><body>cdn root</body></html>",
                cookies: [],
                userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
              },
            });
          }
        } catch {
          // continue
        }
        if (target.includes(".html")) {
          return Response.json({
            status: "ok",
            solution: {
              url: target,
              status: 200,
              response: "<html><body>book</body></html>",
              cookies: [{ name: "PHPSESSID", value: "warm", expires: -1 }],
              userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
            },
          });
        }
        return Response.json({ status: "error", message: "unexpected" });
      },
    });
    servers.push(flare);

    const dbDir = await mkdtemp(join(tmpdir(), "4read-audio-flare-db-"));
    tempDirs.push(dbDir);
    const db = openDb(dbDir);
    const config = configSchema.parse({
      paths: { data: dbDir },
      source: {
        baseUrl: `http://127.0.0.1:${origin.port}`,
        minIntervalMs: 0,
        challengeCooldownMs: 50,
        requestTimeoutMs: 5_000,
      },
      flaresolverr: { url: `http://127.0.0.1:${flare.port}/`, mode: "always", maxTimeoutMs: 5_000 },
    });
    const fetcher = new Fetcher(db, config);
    fetchers.push(fetcher);

    const target = join(dir, "book");
    const result = await ensureAudioFromPlaylist(book(), target, config, fetcher);
    expect(result?.downloaded).toBe(1);
    expect(await readdir(target)).toContain("0001-a.mp3");
    expect(flareRequests.some((r) => r.download === true && String(r.url ?? "").includes(".m3u"))).toBe(
      true,
    );
    // Tracks: warm CDN origin, then same-origin executeJs fetch (not cross-origin from book HTML).
    expect(
      flareRequests.some(
        (r) => String(r.executeJs ?? "").includes("arrayBuffer"),
      ),
    ).toBe(true);
    expect(flareRequests.some((r) => r.returnScreenshot === true)).toBe(false);
    expect(flareRequests.some((r) => String(r.url ?? "").includes(".m3u"))).toBe(true);
  });
});
