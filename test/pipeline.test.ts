import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppContext } from "../src/context.ts";
import { catalogCounts, getBook, booksForSubscription } from "../src/catalog/store.ts";
import { backfillDetails, fetchBookDetail, seedEntities, syncSitemap } from "../src/jobs/crawl.ts";
import { listQueue, refreshQueue, setQueueState } from "../src/jobs/subscriptions.ts";
import { syncLibrary } from "../src/jobs/sync.ts";
import { createApp } from "../src/web/server.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

interface Fake {
  dir: string;
  ctx: AppContext;
  origin: ReturnType<typeof Bun.serve>;
  abs: ReturnType<typeof Bun.serve>;
  scanned: string[];
  close: () => Promise<void>;
}

const fakes: Fake[] = [];

afterEach(async () => {
  while (fakes.length > 0) {
    const fake = fakes.pop();
    if (fake) await fake.close();
  }
});

/**
 * A fake 4read.org that serves the captured fixtures, plus a fake Audiobookshelf whose one
 * library item matches the HPMOR volume, so the whole pipeline can run offline.
 */
async function buildFake(options: { absItems?: unknown[] } = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), "4read-abs-pipeline-"));
  const library = join(dir, "library");
  const itemPath = join(library, "Yudkovski", "HPMOR 2");
  const scanned: string[] = [];

  const [book6840, book3130, authors, readers, seriesListing] = await Promise.all([
    fixture("book-6840-vsi-molodi-chuvaki.html"),
    fixture("book-3130-hpmor-2.html"),
    fixture("index-authors.html"),
    fixture("index-readers.html"),
    fixture("listing-series.html"),
  ]);

  // Filled in once the port is known; the handler only reads it per request.
  let originBase = "";

  const origin = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { pathname } = new URL(request.url);
      // Captured pages carry absolute https://4read.org links, including the cover in
      // og:image. Repointing them at this server makes the mock a faithful stand-in.
      const send = (body: string, type = "text/html"): Response =>
        new Response(body.replaceAll("https://4read.org/", originBase), {
          headers: { "content-type": type },
        });

      if (pathname === "/avtors.html") return send(authors);
      if (pathname === "/readers.html") return send(readers);
      if (pathname === "/sitemap.xml") {
        return send(
          `<?xml version="1.0"?><sitemapindex><sitemap><loc>${originBase}news_pages.xml</loc></sitemap></sitemapindex>`,
          "application/xml",
        );
      }
      if (pathname === "/news_pages.xml") {
        return send(
          `<?xml version="1.0"?><urlset>
             <url><loc>${originBase}6840-mskingbean89-vsi-molodi-chuvaki-pershij-rik.html</loc><lastmod>2026-01-05T10:00:00+02:00</lastmod></url>
             <url><loc>${originBase}3130-yudkovski-elizer-garri-potter-i-metody-racionalnosty-t-2.html</loc><lastmod>2023-09-01T10:00:00+03:00</lastmod></url>
             <url><loc>${originBase}8130-diktoram-nagolosi.html</loc><lastmod>2026-08-01T10:00:00+03:00</lastmod></url>
           </urlset>`,
          "application/xml",
        );
      }
      if (pathname.startsWith("/6840-")) return send(book6840);
      if (pathname.startsWith("/3130-")) return send(book3130);
      // A blog post: same URL shape, but no book markup.
      if (pathname.startsWith("/8130-")) return send("<html><body><h1>Дикторам - наголоси!</h1></body></html>");
      if (pathname.includes("/xfsearch/cikl/")) return send(seriesListing);
      if (pathname.startsWith("/uploads/")) {
        // Fixture covers end in .jpg. Serve a real JPEG larger than the cache's 64-byte floor.
        const jpeg = Uint8Array.from(
          atob(
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEBAVFRUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAAFBgMEBwIBAP/EAD0QAAIBAwMCBAMFBQkAAAAAAAECAwAEEQUSITFBBhMiUWFxMoGRFCNCscHRFSQzUmLh8PEWJDNTgpKi/8QAGQEAAwEBAQAAAAAAAAAAAAAAAAECAwQF/8QAIhEAAgICAgMBAQEAAAAAAAAAAAECEQMhEjFBUQQiYRNh/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
          ),
          (c) => c.charCodeAt(0),
        );
        return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
      }
      if (pathname.startsWith("/m33u2/") && pathname.endsWith(".m3u")) {
        const mp3 = `${originBase}audio/track.mp3`;
        return new Response(`#EXTM3U\n#EXTINF:-1,Track\n${mp3}\n`, {
          headers: { "content-type": "audio/x-mpegurl" },
        });
      }
      if (pathname.startsWith("/audio/") && pathname.endsWith(".mp3")) {
        const mp3 = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);
        return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  originBase = `http://localhost:${origin.port}/`;

  const items =
    options.absItems ??
    [
      {
        id: "li_hpmor2",
        libraryId: "lib_books",
        path: itemPath,
        relPath: "Yudkovski/HPMOR 2",
        media: {
          tags: [],
          numAudioFiles: 2,
          metadata: {
            title: "Гаррі Поттер і методи раціональности. Книга 2",
            authorName: "Елізер Юдковскі",
            narratorName: "",
            seriesName: "",
            genres: [],
          },
        },
      },
    ];

  const abs = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.headers.get("authorization") !== "Bearer test-key") {
        return new Response("unauthorized", { status: 401 });
      }
      if (pathname === "/api/ping") return Response.json({ success: true });
      if (pathname === "/api/libraries") {
        return Response.json({ libraries: [{ id: "lib_books", name: "Books", mediaType: "book" }] });
      }
      if (pathname === "/api/libraries/lib_books/items") return Response.json({ results: items, total: items.length });
      if (pathname === "/api/libraries/lib_books/scan") return Response.json({ ok: true });
      const itemScan = /^\/api\/items\/([^/]+)\/scan$/.exec(pathname);
      if (itemScan) {
        scanned.push(itemScan[1]!);
        return Response.json({ result: "UPDATED" });
      }
      const single = /^\/api\/items\/([^/]+)$/.exec(pathname);
      if (single) {
        const found = (items as Array<{ id: string }>).find((entry) => entry.id === single[1]);
        return found ? Response.json(found) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const configPath = join(dir, "config.yaml");
  await Bun.write(
    configPath,
    `logLevel: warn
paths:
  data: ${JSON.stringify(join(dir, "data"))}
  staging: ${JSON.stringify(join(dir, "staging"))}
  absLibrary: ${JSON.stringify(library)}
source:
  baseUrl: "http://localhost:${origin.port}"
  minIntervalMs: 0
audiobookshelf:
  url: "http://localhost:${abs.port}"
  apiKey: test-key
narrators:
  prefer:
    - Характерник
subscriptions:
  - type: narrator
    value: Характерник
  - type: series
    value: all the young dudes
schedule:
  incrementalMinutes: 0
  backfillEnabled: false
  syncMinutes: 0
`,
  );

  // The context reads secrets from the environment; make sure none leak in from the host
  // (or from another test file running in parallel).
  for (const key of [
    "ABS_URL",
    "ABS_API_KEY",
    "HARDCOVER_API_KEY",
    "HARDCOVER_ENABLED",
    "FLARESOLVERR_URL",
    "STAGING_DIR",
    "DATA_DIR",
    "ABS_LIBRARY_DIR",
    "SOURCE_BASE_URL",
    "OPENAI_API_KEY",
    "OPENCODE_GO_API_KEY",
    "AI_API_KEY",
    "AI_ENABLED",
    "COVERS_PREFER",
  ]) {
    delete process.env[key];
  }
  process.env.HARDCOVER_ENABLED = "false";
  process.env.AI_ENABLED = "false";

  const ctx = new AppContext(configPath);

  const fake: Fake = {
    dir,
    ctx,
    origin,
    abs,
    scanned,
    close: async () => {
      await ctx.close();
      await origin.stop(true);
      await abs.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
  fakes.push(fake);
  return fake;
}

/** Detail-fetch known fixture books (scheduled backfill never walks the whole sitemap). */
async function fetchTestDetails(ctx: AppContext, ids: number[] = [6840, 3130, 8130]): Promise<void> {
  for (const sourceId of ids) {
    await fetchBookDetail(ctx, sourceId);
  }
}

describe("catalogue pipeline", () => {
  test("seeds entities from the two index pages", async () => {
    const fake = await buildFake();
    const result = await seedEntities(fake.ctx);

    expect(result.authors).toBeGreaterThan(1000);
    expect(result.narrators).toBeGreaterThan(500);

    const counts = catalogCounts(fake.ctx.db);
    expect(counts.authors).toBe(result.authors);
    expect(counts.narrators).toBe(result.narrators);
  }, 15_000);

  test("sitemap registers articles as pending and reports what changed", async () => {
    const fake = await buildFake();
    const first = await syncSitemap(fake.ctx);
    expect(first.total).toBe(3);
    expect(first.added).toBe(3);

    // Re-running with unchanged lastmod values must not queue anything again.
    const second = await syncSitemap(fake.ctx);
    expect(second.added).toBe(0);
    expect(second.stale).toBe(0);
  });

  test("detail fetch stores full pages and related pending siblings", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);

    const book = getBook(fake.ctx.db, 6840)!;
    expect(book.title).toBe("Всі молоді чуваки: Перший рік");
    expect(book.authors).toEqual(["MsKingBean89"]);
    expect(book.narrators).toEqual(["BooGaGaрня"]);
    expect(book.series_name).toBe("All the Young Dudes");
    expect(book.series_seq).toBe("1");
    expect(book.genres).toContain("Фентезі");
    expect(book.duration_sec).toBe(19732);
    expect(book.work_key).not.toBeNull();

    // Sibling volumes referenced in the description become pending entries of their own.
    const sibling = getBook(fake.ctx.db, 6862);
    expect(sibling?.detail_state).toBe("pending");

    expect(getBook(fake.ctx.db, 8130)?.detail_state).toBe("skipped");
  });

  test("subscription lookups work by key and by display name", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);

    expect(booksForSubscription(fake.ctx.db, "narrator", "Характерник").map((b) => b.source_id)).toEqual([3130]);
    expect(booksForSubscription(fake.ctx.db, "narrator", "характерник").map((b) => b.source_id)).toEqual([3130]);
    expect(booksForSubscription(fake.ctx.db, "series", "All the Young Dudes").map((b) => b.source_id)).toEqual([6840]);
    expect(booksForSubscription(fake.ctx.db, "genre", "fentezi").length).toBe(2);
    expect(booksForSubscription(fake.ctx.db, "author", "MsKingBean89").map((b) => b.source_id)).toEqual([6840]);
  });

  test("the queue fills from subscriptions and records why", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    const result = await refreshQueue(fake.ctx);

    expect(result.subscriptions).toBe(2);
    expect(result.queued).toBe(2);

    const entries = await listQueue(fake.ctx, "new");
    const hpmor = entries.find((entry) => entry.source_id === 3130)!;
    expect(hpmor.reason).toContain("narrator:Характерник");
    expect(hpmor.book?.title).toContain("Книга 2");
    expect(hpmor.coverUrl).toMatch(/^\/api\/covers\/3130/);
  });

  test("facet crawl links series without a detail fetch, and backfill stays on-topic", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);

    const empty = await backfillDetails(fake.ctx, 10);
    expect(empty.attempted).toBe(0);

    const queued = await refreshQueue(fake.ctx, { crawlFacets: true });
    expect(queued.matched).toBeGreaterThan(0);
    expect(booksForSubscription(fake.ctx.db, "series", "all the young dudes").length).toBeGreaterThan(0);

    const scoped = await backfillDetails(fake.ctx, 1);
    expect(scoped.attempted).toBe(1);
    expect(scoped.ok).toBe(1);
    // Only the series volume overlapping the sitemap should be detailed, not the blog post.
    expect(getBook(fake.ctx.db, 6840)?.detail_state).toBe("ok");
    expect(getBook(fake.ctx.db, 8130)?.detail_state).toBe("pending");
  });

  test("accept and ignore move entries between states", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await refreshQueue(fake.ctx);

    setQueueState(fake.ctx, 3130, "ignored");
    expect((await listQueue(fake.ctx, "new")).some((entry) => entry.source_id === 3130)).toBe(false);
    expect(await listQueue(fake.ctx, "ignored")).toHaveLength(1);
  });
});

describe("audiobookshelf sync", () => {
  test("matches an item, writes the sidecar and triggers a rescan", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);

    const result = await syncLibrary(fake.ctx);

    expect(result.errors).toEqual([]);
    expect(result.matched).toBe(1);
    expect(result.written).toBe(1);
    expect(fake.scanned).toEqual(["li_hpmor2"]);

    const written = JSON.parse(
      await readFile(join(fake.dir, "library", "Yudkovski", "HPMOR 2", "metadata.json"), "utf8"),
    );
    expect(written.narrators).toEqual(["Характерник"]);
    expect(written.series).toEqual(["Гаррі Поттер #2"]);
    expect(written.genres).toContain("Фентезі");
    expect(written.tags).toContain("4read:3130");
    expect(written.language).toBe("ukr");

    // The cover travels with the sidecar (fixture URLs are .jpg).
    const cover = Bun.file(join(fake.dir, "library", "Yudkovski", "HPMOR 2", "cover.jpg"));
    expect(await cover.exists()).toBe(true);
  });

  test("a second sync writes nothing and does not rescan", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await syncLibrary(fake.ctx);
    fake.scanned.length = 0;

    const again = await syncLibrary(fake.ctx);
    expect(again.written).toBe(0);
    expect(fake.scanned).toEqual([]);
  });

  test("an item tagged with our marker is matched exactly, even with a different title", async () => {
    const fake = await buildFake({
      absItems: [
        {
          id: "li_renamed",
          libraryId: "lib_books",
          path: join((await mkdtemp(join(tmpdir(), "4read-abs-item-"))), "Renamed"),
          relPath: "Renamed",
          media: {
            tags: ["4read:6840"],
            numAudioFiles: 1,
            metadata: { title: "Completely Different Title", authorName: "Nobody" },
          },
        },
      ],
    });
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);

    const result = await syncLibrary(fake.ctx);
    expect(result.matched).toBe(1);
    expect(result.outcomes[0]?.sourceId).toBe(6840);
  });

  test("items that cannot be matched are reported rather than guessed", async () => {
    const fake = await buildFake({
      absItems: [
        {
          id: "li_unknown",
          libraryId: "lib_books",
          path: "/audiobooks/Unknown/Thing",
          relPath: "Unknown/Thing",
          media: { tags: [], metadata: { title: "Zzz Unrelated Book", authorName: "Nobody At All" } },
        },
      ],
    });
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);

    const result = await syncLibrary(fake.ctx);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });

  test("createFolders prepares a folder for an accepted book", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await refreshQueue(fake.ctx);
    setQueueState(fake.ctx, 6840, "accepted");

    fake.ctx.config.sync.createFolders = true;
    const result = await syncLibrary(fake.ctx);
    expect(result.created).toBe(1);

    // The colon is dropped: folder segments have to be safe on every filesystem.
    const folder = join(
      fake.dir,
      "library",
      "MsKingBean89",
      "All the Young Dudes",
      "1 - Всі молоді чуваки Перший рік",
    );
    const written = JSON.parse(await readFile(join(folder, "metadata.json"), "utf8"));
    expect(written.title).toBe("Всі молоді чуваки: Перший рік");
    expect(written.series).toEqual(["All the Young Dudes #1"]);
    const mp3s = (await readdir(folder)).filter((name) => name.endsWith(".mp3"));
    expect(mp3s).toEqual(["0001-track.mp3"]);
  });

  test("prepared folders without media get audio on the next sync", async () => {
    const fake = await buildFake({ absItems: [] });
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await refreshQueue(fake.ctx);

    const folder = join(
      fake.dir,
      "library",
      "MsKingBean89",
      "All the Young Dudes",
      "1 - Всі молоді чуваки Перший рік",
    );
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "metadata.json"), JSON.stringify({ title: "stub" }));
    await writeFile(join(folder, "cover.jpg"), "cover");
    setQueueState(fake.ctx, 6840, "prepared", folder);

    fake.ctx.config.sync.createFolders = true;
    const result = await syncLibrary(fake.ctx);
    expect(result.created).toBe(1);
    expect((await readdir(folder)).filter((name) => name.endsWith(".mp3"))).toEqual(["0001-track.mp3"]);
  });
});

describe("http api", () => {
  test("status reports the catalogue, integrations and jobs", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    const app = createApp(fake.ctx);

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    const status = (await response.json()) as Record<string, any>;

    expect(status.catalog.books).toBe(3);
    expect(status.integrations.audiobookshelf).toBe(true);
    expect(status.subscriptions).toHaveLength(2);
    expect(status.jobs.map((job: { name: string }) => job.name)).toContain("sync");
  });

  test("the config endpoint round trips an edit and reloads it", async () => {
    const fake = await buildFake();
    const app = createApp(fake.ctx);

    const before = (await (await app.request("/api/config")).json()) as { text: string };
    expect(before.text).toContain("subscriptions:");

    const edited = before.text.replace("logLevel: warn", "logLevel: error");
    const save = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: edited }),
    });
    expect(save.status).toBe(200);
    expect(fake.ctx.config.logLevel).toBe("error");
  });

  test("invalid yaml is rejected without changing the running config", async () => {
    const fake = await buildFake();
    const app = createApp(fake.ctx);

    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "subscriptions:\n  - type: nope\n    value: x\n" }),
    });
    expect(response.status).toBe(400);
    expect(fake.ctx.config.subscriptions).toHaveLength(2);
  });

  test("queue actions are exposed over http", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await refreshQueue(fake.ctx);
    const app = createApp(fake.ctx);

    const accept = await app.request("/api/queue/3130/accept", { method: "POST" });
    expect(accept.status).toBe(200);

    const listed = (await (await app.request("/api/queue?state=accepted")).json()) as { entries: unknown[] };
    expect(listed.entries).toHaveLength(1);

    const bad = await app.request("/api/queue/3130/explode", { method: "POST" });
    expect(bad.status).toBe(400);
  });

  test("deleting a queue entry allows it to be re-queued", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    await refreshQueue(fake.ctx);
    const app = createApp(fake.ctx);

    setQueueState(fake.ctx, 3130, "prepared", join(fake.dir, "library", "prepared-book"));
    await mkdir(join(fake.dir, "library", "prepared-book"), { recursive: true });
    await writeFile(join(fake.dir, "library", "prepared-book", "0001-track.mp3"), "x".repeat(2048));
    await writeFile(join(fake.dir, "library", "prepared-book", ".4read-audio-playlist"), "http://x/a.m3u");

    const del = await app.request("/api/queue/3130", { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean; clearedAudio: number };
    expect(body.ok).toBe(true);
    expect(body.clearedAudio).toBeGreaterThan(0);

    const gone = (await (await app.request("/api/queue?state=all")).json()) as {
      entries: Array<{ source_id: number }>;
    };
    expect(gone.entries.every((entry) => entry.source_id !== 3130)).toBe(true);

    const again = await refreshQueue(fake.ctx);
    expect(again.queued).toBeGreaterThan(0);
    const restored = await listQueue(fake.ctx, "new");
    expect(restored.some((entry) => entry.source_id === 3130)).toBe(true);
  });

  test("covers are served from our own cache, not from the source", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    // Syncing caches the cover for the matched book in staging.
    await syncLibrary(fake.ctx);
    const app = createApp(fake.ctx);

    const response = await app.request("/api/covers/3130");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect((await response.bytes()).length).toBeGreaterThan(64);
  });

  test("an uncached cover reports 404 instead of blocking on the source", async () => {
    const fake = await buildFake();
    await syncSitemap(fake.ctx);
    await fetchTestDetails(fake.ctx);
    const app = createApp(fake.ctx);

    const started = Date.now();
    const response = await app.request("/api/covers/6840");
    expect(response.status).toBe(404);
    // The download happens in the background, so the request must return immediately.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an unknown book has no cover", async () => {
    const fake = await buildFake();
    const app = createApp(fake.ctx);
    expect((await app.request("/api/covers/999999")).status).toBe(404);
  });

  test("the ui is served and unknown jobs are refused", async () => {
    const fake = await buildFake();
    const app = createApp(fake.ctx);

    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("4read");

    const unknown = await app.request("/api/jobs/nonsense/run", { method: "POST" });
    expect(unknown.status).toBe(404);
  });
});
