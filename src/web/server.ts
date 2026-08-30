import { Hono } from "hono";
// Imported as text so the page is embedded in the compiled binary. Bun types any `.html`
// import as an HTMLBundle regardless of the attribute, hence the cast.
import indexHtmlAsset from "./ui/index.html" with { type: "text" };
import type { AppContext } from "../context.ts";
import { compactConfigText, parseConfigText, redactConfigText, saveConfigText } from "../config.ts";
import { catalogCounts, getBook } from "../catalog/store.ts";
import { cacheCoverInBackground, cachedCover } from "../covers.ts";
import { buildSidecar } from "../abs/metadata.ts";
import { stageBook } from "../abs/stage.ts";
import { getMeta } from "../db.ts";
import { recentLogs } from "../log.ts";
import { backfillDetails, seedEntities, syncSitemap } from "../jobs/crawl.ts";
import { listQueue, queueCounts, refreshQueue, setQueueState, deleteQueueEntry } from "../jobs/subscriptions.ts";
import { prepareAcceptedBook, syncLibrary } from "../jobs/sync.ts";
import { logger } from "../log.ts";
import { VERSION } from "../version.ts";

const log = logger("web");

const indexHtml = indexHtmlAsset as unknown as string;

const JOBS = ["seed", "sitemap", "backfill", "subscriptions", "sync"] as const;
type JobName = (typeof JOBS)[number];

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(indexHtml));
  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/api/status", (c) => {
    const limiter = ctx.fetcher.limiter.state();
    return c.json({
      version: VERSION,
      startedAt: ctx.startedAt,
      catalog: catalogCounts(ctx.db),
      queue: queueCounts(ctx),
      timestamps: {
        seededAt: getMeta(ctx.db, "seeded_at"),
        sitemapSyncedAt: getMeta(ctx.db, "sitemap_synced_at"),
        backfillRanAt: getMeta(ctx.db, "backfill_ran_at"),
        syncRanAt: getMeta(ctx.db, "sync_ran_at"),
      },
      fetch: {
        intervalMs: limiter.intervalMs,
        requests: limiter.requests,
        challenges: limiter.challenges,
        consecutiveChallenges: limiter.consecutiveChallenges,
        cooldownRemainingMs: ctx.fetcher.limiter.cooldownRemainingMs(),
        hasClearance: ctx.fetcher.jar.hasClearance(),
        flaresolverr: ctx.fetcher.flareConfigured ? ctx.config.flaresolverr.mode : "not configured",
      },
      integrations: {
        audiobookshelf: ctx.abs.configured,
        audiobookshelfUrl: ctx.config.audiobookshelf.url || null,
        audioDownload: true,
        absLibraryPath: ctx.config.paths.absLibrary || null,
        stagingPath: ctx.config.paths.staging,
      },
      subscriptions: ctx.config.subscriptions,
      preferredNarrators: ctx.config.narrators.prefer,
      jobs: [...JOBS].map((name) => ctx.jobStatus(name)),
    });
  });

  app.get("/api/logs", (c) => c.json({ lines: recentLogs(300) }));

  app.get("/api/config", (c) => {
    // Drop unused / default keys so the editor only shows meaningful overrides.
    const text = compactConfigText(ctx.configText);
    return c.json({
      path: ctx.configPath,
      text,
      // Secrets come from the environment; never echo them into the editor.
      redacted: redactConfigText(text),
    });
  });

  app.put("/api/config", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    if (!body || typeof body.text !== "string") return c.json({ error: "expected { text }" }, 400);
    try {
      const config = await saveConfigText(body.text, ctx.configPath);
      const compact = compactConfigText(body.text);
      ctx.reload(config, compact);
      log.info("configuration reloaded");
      return c.json({ ok: true, text: compact });
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  app.post("/api/config/validate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    if (!body || typeof body.text !== "string") return c.json({ error: "expected { text }" }, 400);
    try {
      parseConfigText(body.text);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 200);
    }
  });

  app.get("/api/queue", async (c) => {
    const state = c.req.query("state") ?? undefined;
    return c.json({ entries: await listQueue(ctx, state === "all" ? undefined : (state ?? "new")) });
  });

  app.post("/api/queue/:sourceId/:action", (c) => {
    const sourceId = Number.parseInt(c.req.param("sourceId"), 10);
    const action = c.req.param("action");
    if (!Number.isFinite(sourceId)) return c.json({ error: "bad source id" }, 400);
    const states: Record<string, string> = {
      accept: "accepted",
      ignore: "ignored",
      reset: "new",
    };
    const state = states[action];
    if (!state) return c.json({ error: `unknown action ${action}` }, 400);
    setQueueState(ctx, sourceId, state);

    // Accept starts folder + audio download immediately — no separate Sync step.
    let downloadStarted = false;
    if (action === "accept") {
      downloadStarted = true;
      const jobName = `prepare-${sourceId}`;
      void ctx
        .runJob(jobName, () => prepareAcceptedBook(ctx, sourceId))
        .catch((error) => log.warn(`prepare ${sourceId} failed: ${String(error)}`));
    }

    return c.json({ ok: true, state, downloadStarted });
  });

  app.delete("/api/queue/:sourceId", async (c) => {
    const sourceId = Number.parseInt(c.req.param("sourceId"), 10);
    if (!Number.isFinite(sourceId)) return c.json({ error: "bad source id" }, 400);
    const result = await deleteQueueEntry(ctx, sourceId);
    return c.json(result);
  });

  /**
   * Serves the cover from the staging cache rather than letting the browser hit the source
   * directly, where it would run into the same Cloudflare challenge. A cover that has not been
   * cached yet is fetched in the background, because the source is rate limited and a UI
   * request must not wait on it.
   */
  app.get("/api/covers/:sourceId", async (c) => {
    const sourceId = Number.parseInt(c.req.param("sourceId"), 10);
    const book = Number.isFinite(sourceId) ? getBook(ctx.db, sourceId) : null;
    if (!book) return c.json({ error: "not found" }, 404);

    const cached = await cachedCover(book, ctx.config);
    if (cached) {
      return new Response(Bun.file(cached.path), {
        headers: {
          "content-type": cached.contentType,
          etag: `"${cached.version}"`,
          // Versioned by the query string from coverProxyUrl; a short TTL is fine.
          "cache-control": "public, max-age=3600",
        },
      });
    }

    cacheCoverInBackground(ctx.fetcher, book, ctx.config, async (cover) => {
      await stageBook(book, buildSidecar(book, ctx.config), cover, ctx.config);
    });
    return c.json({ error: "not cached yet" }, 404);
  });

  app.get("/api/books/:sourceId", (c) => {
    const sourceId = Number.parseInt(c.req.param("sourceId"), 10);
    const book = Number.isFinite(sourceId) ? getBook(ctx.db, sourceId) : null;
    if (!book) return c.json({ error: "not found" }, 404);
    return c.json({ book });
  });

  app.post("/api/jobs/:name/run", (c) => {
    const name = c.req.param("name") as JobName;
    if (!JOBS.includes(name)) return c.json({ error: `unknown job ${name}` }, 404);
    if (ctx.jobStatus(name).running) return c.json({ ok: false, error: "already running" }, 409);

    const task = (): Promise<unknown> => {
      switch (name) {
        case "seed":
          return seedEntities(ctx);
        case "sitemap":
          return syncSitemap(ctx);
        case "backfill":
          return backfillDetails(ctx, Math.max(1, ctx.config.schedule.backfillBatch));
        case "subscriptions":
          return refreshQueue(ctx, { crawlFacets: true });
        case "sync":
          return syncLibrary(ctx);
      }
    };

    // Jobs can run for a long time, so the request returns as soon as it is accepted.
    void ctx.runJob(name, task).catch((error) => log.warn(`${name} failed: ${String(error)}`));
    return c.json({ ok: true, started: name }, 202);
  });

  return app;
}
