import { AppContext } from "./context.ts";
import { logger } from "./log.ts";
import { backfillDetails, seedEntities, syncSitemap } from "./jobs/crawl.ts";
import { Scheduler } from "./jobs/scheduler.ts";
import { refreshQueue } from "./jobs/subscriptions.ts";
import { syncLibrary } from "./jobs/sync.ts";
import { createApp } from "./web/server.ts";
import { VERSION } from "./version.ts";

const log = logger("main");

const USAGE = `4read-abs - 4read.org audiobook metadata for Audiobookshelf

Usage:
  4read-abs [serve]        Start the web UI and the scheduler (default)
  4read-abs seed           Fetch the author and narrator indexes
  4read-abs sitemap        Reconcile the catalogue with the site's sitemap
  4read-abs backfill [n]   Fetch up to n pending detail pages (default: config value)
  4read-abs subscriptions  Re-evaluate subscriptions and refill the news queue
  4read-abs sync           Write sidecars into the Audiobookshelf library
  4read-abs once           sitemap, then subscriptions, then sync
  4read-abs --version      Print the version

Environment:
  CONFIG_FILE              Path to config.yaml (default: ./config.yaml)
  DATA_DIR                 SQLite and cookie storage (default: ./data)
  STAGING_DIR              Per-book staging folders (default: ./staging)
  ABS_LIBRARY_DIR          Audiobookshelf library as mounted for this process
  ABS_URL, ABS_API_KEY     Audiobookshelf server and API key
  HARDCOVER_API_KEY        Enables Hardcover enrichment
  COVERS_PREFER            hardcover-first (default) | hardcover-only | source
  OPENAI_API_KEY           Optional OpenAI-compatible key (OpenCode Go / Zen)
  OPENAI_BASE_URL          Default https://opencode.ai/zen/go/v1
  OPENAI_MODEL             Default mimo-v2.5 (recommended on OpenCode Go)
  FLARESOLVERR_URL         FlareSolverr endpoint, e.g. http://127.0.0.1:8191/v1
  FLARESOLVERR_MODE        auto (default) | always | never
  AUDIO_TRACK_CONCURRENCY  Parallel CDN mp3 downloads per book (default: 5)
  AUDIO_TRACK_TIMEOUT_MS   Per-track CDN download timeout (default: 600000)
  HOST, PORT               Web UI bind address (default: 127.0.0.1:8480)
  LOG_LEVEL                debug | info | warn | error
`;

async function serve(ctx: AppContext): Promise<void> {
  const app = createApp(ctx);
  const server = Bun.serve({
    hostname: ctx.config.server.host,
    port: ctx.config.server.port,
    fetch: app.fetch,
    idleTimeout: 120,
  });

  const scheduler = new Scheduler(ctx);
  scheduler.start();

  log.info(`web UI on http://${server.hostname}:${server.port}`);
  if (!ctx.abs.configured) log.warn("Audiobookshelf is not configured; set ABS_URL and ABS_API_KEY");
  if (!ctx.fetcher.flareConfigured) {
    log.warn("FlareSolverr is not configured; direct requests will fail once Cloudflare challenges");
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
    await server.stop(true);
    await ctx.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const [command = "serve", ...rest] = process.argv.slice(2);

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  const ctx = new AppContext();

  try {
    switch (command) {
      case "serve":
        await serve(ctx);
        return; // The server keeps the process alive.
      case "seed":
        console.log(JSON.stringify(await seedEntities(ctx), null, 2));
        break;
      case "sitemap":
        console.log(JSON.stringify(await syncSitemap(ctx), null, 2));
        break;
      case "backfill": {
        const limit = Number.parseInt(rest[0] ?? "", 10);
        const batch = Number.isFinite(limit) ? limit : ctx.config.schedule.backfillBatch;
        console.log(JSON.stringify(await backfillDetails(ctx, batch), null, 2));
        break;
      }
      case "subscriptions":
      case "subs":
        console.log(JSON.stringify(await refreshQueue(ctx, { crawlFacets: true }), null, 2));
        break;
      case "sync": {
        const result = await syncLibrary(ctx);
        // The per-item detail is verbose; the summary is what matters on a terminal.
        console.log(JSON.stringify({ ...result, outcomes: result.outcomes.length }, null, 2));
        break;
      }
      case "once": {
        await syncSitemap(ctx);
        await refreshQueue(ctx, { crawlFacets: true });
        if (ctx.abs.configured) {
          const result = await syncLibrary(ctx);
          console.log(JSON.stringify({ ...result, outcomes: result.outcomes.length }, null, 2));
        }
        break;
      }
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exitCode = 2;
        break;
    }
  } finally {
    if (command !== "serve") await ctx.close();
  }
}

await main();
