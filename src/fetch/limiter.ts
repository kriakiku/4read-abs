import { logger } from "../log.ts";

const log = logger("limiter");

export interface LimiterOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  challengeCooldownMs: number;
  /** Consecutive challenges before the limiter stops trying for a while. */
  cooldownAfterChallenges?: number;
}

export interface LimiterState {
  intervalMs: number;
  consecutiveChallenges: number;
  cooldownUntil: number | null;
  lastRequestAt: number | null;
  requests: number;
  challenges: number;
}

/**
 * Paces requests to a single origin. Cloudflare on this source reacts to burst volume
 * rather than to a fixed rate, so the interval grows on every challenge and decays back
 * down while things are healthy.
 */
export class AdaptiveLimiter {
  private intervalMs: number;
  private lastRequestAt: number | null = null;
  private consecutiveChallenges = 0;
  private cooldownUntil: number | null = null;
  private requests = 0;
  private challenges = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: LimiterOptions) {
    this.intervalMs = options.minIntervalMs;
  }

  state(): LimiterState {
    return {
      intervalMs: this.intervalMs,
      consecutiveChallenges: this.consecutiveChallenges,
      cooldownUntil: this.cooldownUntil,
      lastRequestAt: this.lastRequestAt,
      requests: this.requests,
      challenges: this.challenges,
    };
  }

  /** True while the limiter is deliberately refusing to touch the origin. */
  inCooldown(): boolean {
    if (this.cooldownUntil === null) return false;
    if (Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = null;
      this.consecutiveChallenges = 0;
      return false;
    }
    return true;
  }

  cooldownRemainingMs(): number {
    if (!this.inCooldown()) return 0;
    return Math.max(0, (this.cooldownUntil ?? 0) - Date.now());
  }

  /**
   * Serialises callers and holds each one until the pacing interval (and any cooldown) has
   * elapsed. Re-checks after sleeping so a challenge recorded by the previous caller still
   * delays the next one.
   */
  async acquire(): Promise<void> {
    const wait = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const earliest = this.lastRequestAt === null ? now : this.lastRequestAt + this.intervalMs;
        const cooldown = this.cooldownUntil && this.cooldownUntil > now ? this.cooldownUntil : now;
        const target = Math.max(earliest, cooldown);
        if (target <= now) break;
        await Bun.sleep(target - now);
      }
      this.lastRequestAt = Date.now();
      this.requests += 1;
    });
    // Keep the chain alive even if a caller throws later on.
    this.chain = wait.catch(() => undefined);
    return wait;
  }

  /** A plain request got through without a challenge — the origin is healthy again. */
  recordSuccess(): void {
    this.consecutiveChallenges = 0;
    this.cooldownUntil = null;
    if (this.intervalMs > this.options.minIntervalMs) {
      this.intervalMs = Math.max(this.options.minIntervalMs, Math.round(this.intervalMs * 0.8));
    }
  }

  recordChallenge(): void {
    this.challenges += 1;
    this.consecutiveChallenges += 1;
    this.intervalMs = Math.min(this.options.maxIntervalMs, Math.max(1000, this.intervalMs * 2));
    const limit = this.options.cooldownAfterChallenges ?? 3;
    if (this.consecutiveChallenges >= limit) {
      this.cooldownUntil = Date.now() + this.options.challengeCooldownMs;
      log.warn(
        `${this.consecutiveChallenges} consecutive challenges, pausing for ${Math.round(
          this.options.challengeCooldownMs / 1000,
        )}s`,
      );
    } else {
      log.debug(`challenge, interval now ${this.intervalMs}ms`);
    }
  }

  recordFailure(): void {
    // Transport errors are not necessarily rate limiting, but slowing down is still safer.
    this.intervalMs = Math.min(this.options.maxIntervalMs, Math.round(this.intervalMs * 1.5));
  }
}
