import type { AppContext } from "../context.ts";
import { getMeta, pruneFetchLog, setMeta } from "../db.ts";
import { logger } from "../log.ts";
import { backfillDetails, seedEntities, syncSitemap } from "./crawl.ts";
import { refreshQueue } from "./subscriptions.ts";
import { syncLibrary } from "./sync.ts";

const log = logger("scheduler");

const MINUTE = 60_000;

function minutesSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / MINUTE;
}

/**
 * Periodic work driven by a single ticker: cheap incremental jobs run on their own cadence and
 * the detail backfill fills whatever time is left over, one small batch at a time.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    // A one minute tick is fine: each job decides for itself whether it is due.
    this.timer = setInterval(() => {
      void this.tick();
    }, MINUTE);
    log.info("scheduler started");
    // Kick off immediately so a fresh install starts filling the catalogue.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runDue();
    } catch (error) {
      log.error(`tick failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runDue(): Promise<void> {
    const { ctx } = this;
    const schedule = ctx.config.schedule;

    if (!getMeta(ctx.db, "seeded_at")) {
      log.info("due: seed");
      await ctx.runJob("seed", () => seedEntities(ctx)).catch((error) => {
        log.warn(`seed failed: ${String(error)}`);
        return null;
      });
    }

    if (schedule.incrementalMinutes > 0 && minutesSince(getMeta(ctx.db, "sitemap_synced_at")) >= schedule.incrementalMinutes) {
      log.info("due: sitemap + subscriptions");
      await ctx.runJob("sitemap", () => syncSitemap(ctx)).catch((error) => {
        log.warn(`sitemap sync failed: ${String(error)}`);
        return null;
      });
      await ctx.runJob("subscriptions", () => refreshQueue(ctx, { crawlFacets: true })).catch((error) => {
        log.warn(`subscription refresh failed: ${String(error)}`);
        return null;
      });
    }

    // Cooldown only blocks Bun→origin probes. With FlareSolverr configured, backfill can continue.
    const backfillBlockedByCooldown =
      ctx.fetcher.limiter.inCooldown() && !ctx.fetcher.flareConfigured;
    if (schedule.backfillEnabled && schedule.backfillBatch > 0 && !backfillBlockedByCooldown) {
      log.info(`due: backfill (batch ${schedule.backfillBatch})`);
      await ctx.runJob("backfill", () => backfillDetails(ctx, schedule.backfillBatch)).catch((error) => {
        log.warn(`backfill failed: ${String(error)}`);
        return null;
      });
    } else if (schedule.backfillEnabled && backfillBlockedByCooldown) {
      log.info(
        `skipping backfill: origin cooldown another ${Math.round(ctx.fetcher.limiter.cooldownRemainingMs() / 1000)}s (no FlareSolverr)`,
      );
    }

    if (
      schedule.syncMinutes > 0 &&
      ctx.abs.configured &&
      minutesSince(getMeta(ctx.db, "sync_ran_at")) >= schedule.syncMinutes
    ) {
      log.info("due: library sync");
      await ctx.runJob("sync", () => syncLibrary(ctx)).catch((error) => {
        log.warn(`library sync failed: ${String(error)}`);
        return null;
      });
    }

    if (minutesSince(getMeta(ctx.db, "pruned_at")) >= 60 * 24) {
      pruneFetchLog(ctx.db);
      setMeta(ctx.db, "pruned_at", new Date().toISOString());
    }

    log.info("scheduler tick finished");
  }
}
