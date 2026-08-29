import type { Config } from "../config.ts";
import { nowIso, type Db } from "../db.ts";
import { logger } from "../log.ts";
import { CookieJar } from "./cookies.ts";
import { FlareSolverrClient } from "./flaresolverr.ts";
import { AdaptiveLimiter } from "./limiter.ts";

const log = logger("fetch");

export type Strategy = "direct" | "flaresolverr";

export interface TextResult {
  url: string;
  status: number;
  body: string;
  strategy: Strategy;
}

export interface BinaryResult {
  url: string;
  status: number;
  bytes: Uint8Array;
  contentType: string | null;
}

export class ChallengeError extends Error {
  constructor(readonly url: string) {
    super(`Cloudflare challenge not solved for ${url}`);
    this.name = "ChallengeError";
  }
}

export class CooldownError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Source is in cooldown for another ${Math.round(remainingMs / 1000)}s`);
    this.name = "CooldownError";
  }
}

/** Cloudflare interstitials are HTML 403/503 pages carrying these markers. */
function looksLikeChallenge(status: number, body: string, headers?: Headers): boolean {
  if (headers?.has("cf-mitigated")) return true;
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return (
    body.includes("_cf_chl_opt") ||
    body.includes("cf-browser-verification") ||
    body.includes("challenge-platform") ||
    /just a moment/i.test(body)
  );
}

export class Fetcher {
  readonly jar: CookieJar;
  readonly limiter: AdaptiveLimiter;
  private readonly flare: FlareSolverrClient;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.jar = new CookieJar(db);
    this.limiter = new AdaptiveLimiter({
      minIntervalMs: config.source.minIntervalMs,
      maxIntervalMs: config.source.maxIntervalMs,
      challengeCooldownMs: config.source.challengeCooldownMs,
    });
    this.flare = new FlareSolverrClient(
      config.flaresolverr.url,
      config.flaresolverr.maxTimeoutMs,
      config.flaresolverr.useSession,
    );
  }

  get flareConfigured(): boolean {
    return this.flare.configured && this.config.flaresolverr.mode !== "never";
  }

  private userAgent(): string {
    return this.jar.userAgent ?? this.config.source.userAgent;
  }

  private browserHeaders(referer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": this.userAgent(),
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": referer ? "same-origin" : "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    if (referer) headers.referer = referer;
    return headers;
  }

  private record(url: string, strategy: Strategy | null, status: number | null, ok: boolean, challenge: boolean, ms: number, error?: string): void {
    this.db
      .query(
        "insert into fetch_log (at, url, strategy, status, ok, challenge, ms, error) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(nowIso(), url, strategy, status, ok ? 1 : 0, challenge ? 1 : 0, Math.round(ms), error ?? null);
  }

  /**
   * Fetch a page as text. Tries a plain request first (cheap, and works once clearance is
   * cached) and escalates to FlareSolverr when a challenge appears.
   */
  async getText(url: string, options: { referer?: string } = {}): Promise<TextResult> {
    if (this.limiter.inCooldown() && this.config.flaresolverr.mode !== "always") {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const mode = this.config.flaresolverr.mode;
    const flareFirst = mode === "always" && this.flare.configured;

    if (!flareFirst) {
      await this.limiter.acquire();
      const started = Bun.nanoseconds();
      try {
        const response = await fetch(url, {
          headers: this.browserHeaders(options.referer),
          redirect: "follow",
          signal: AbortSignal.timeout(this.config.source.requestTimeoutMs),
        });
        const body = await response.text();
        const ms = (Bun.nanoseconds() - started) / 1e6;
        this.jar.absorbSetCookie(response.headers);

        if (!looksLikeChallenge(response.status, body, response.headers)) {
          this.limiter.recordSuccess();
          this.record(url, "direct", response.status, response.ok, false, ms);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
          }
          return { url: response.url || url, status: response.status, body, strategy: "direct" };
        }

        this.limiter.recordChallenge();
        this.record(url, "direct", response.status, false, true, ms);
        log.debug(`challenge on direct fetch of ${url}`);
      } catch (error) {
        const ms = (Bun.nanoseconds() - started) / 1e6;
        if (error instanceof Error && error.name === "ChallengeError") throw error;
        this.limiter.recordFailure();
        this.record(url, "direct", null, false, false, ms, String(error));
        if (!this.flareConfigured) throw error;
        log.debug(`direct fetch failed (${String(error)}), trying FlareSolverr`);
      }
    }

    if (!this.flareConfigured) {
      throw new ChallengeError(url);
    }

    if (this.limiter.inCooldown() && mode !== "always") {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    // FlareSolverr runs its own browser, so it does not consume our pacing budget for the
    // origin in the same way; still serialise to avoid piling up browser sessions.
    await this.limiter.acquire();
    const started = Bun.nanoseconds();
    try {
      const result = await this.flare.get(url);
      const ms = (Bun.nanoseconds() - started) / 1e6;
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);

      if (looksLikeChallenge(result.status, result.body)) {
        this.limiter.recordChallenge();
        this.record(url, "flaresolverr", result.status, false, true, ms);
        throw new ChallengeError(url);
      }
      // Clearance cookies should let later direct requests through.
      this.limiter.recordSuccess();
      this.record(url, "flaresolverr", result.status, result.status < 400, false, ms);
      if (result.status >= 400) {
        throw new Error(`HTTP ${result.status} for ${url} (via FlareSolverr)`);
      }
      return { url, status: result.status, body: result.body, strategy: "flaresolverr" };
    } catch (error) {
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (error instanceof ChallengeError) throw error;
      this.limiter.recordFailure();
      this.record(url, "flaresolverr", null, false, false, ms, String(error));
      throw error;
    }
  }

  /**
   * Fetch binary content such as a cover. Bun's TLS fingerprint cannot reuse FlareSolverr
   * clearance cookies, so a challenged direct download falls back to fetching inside
   * FlareSolverr's browser (download API or a PNG screenshot of the image URL).
   */
  async getBinary(url: string, options: { referer?: string } = {}): Promise<BinaryResult> {
    if (this.limiter.inCooldown()) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const attemptDirect = async (): Promise<BinaryResult | "challenged"> => {
      if (this.limiter.inCooldown()) return "challenged";
      await this.limiter.acquire();
      if (this.limiter.inCooldown()) return "challenged";

      const started = Bun.nanoseconds();
      const headers = this.browserHeaders(options.referer);
      headers.accept = "image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8";
      headers["sec-fetch-dest"] = "image";
      headers["sec-fetch-mode"] = "no-cors";
      headers["sec-fetch-site"] = "same-origin";
      delete headers["upgrade-insecure-requests"];
      delete headers["sec-fetch-user"];

      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.config.source.requestTimeoutMs),
      });
      const contentType = response.headers.get("content-type");
      const ms = (Bun.nanoseconds() - started) / 1e6;
      this.jar.absorbSetCookie(response.headers);

      if (response.status === 403 || response.status === 503 || response.status === 429) {
        this.limiter.recordChallenge();
        this.record(url, "direct", response.status, false, true, ms);
        return "challenged";
      }
      if (!response.ok) {
        this.record(url, "direct", response.status, false, false, ms);
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Cloudflare sometimes returns an HTML interstitial with HTTP 200.
      if (looksLikeChallenge(response.status, new TextDecoder().decode(bytes.slice(0, 2000)), response.headers)) {
        this.limiter.recordChallenge();
        this.record(url, "direct", response.status, false, true, ms);
        return "challenged";
      }
      this.limiter.recordSuccess();
      this.record(url, "direct", response.status, true, false, ms);
      return { url, status: response.status, bytes, contentType };
    };

    // Always try a direct download first. When Cloudflare blocks it, fall back to FlareSolverr's
    // browser — Bun cannot reuse clearance cookies (different TLS fingerprint).
    try {
      const first = await attemptDirect();
      if (first !== "challenged") return first;
    } catch (error) {
      if (error instanceof CooldownError) throw error;
      log.debug(`direct binary fetch failed (${String(error)}), trying FlareSolverr browser`);
    }

    if (this.limiter.inCooldown()) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }
    if (!this.flareConfigured) throw new ChallengeError(url);

    await this.limiter.acquire();
    const started = Bun.nanoseconds();
    try {
      const image = await this.flare.fetchImage(url);
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (!image) {
        this.limiter.recordChallenge();
        this.record(url, "flaresolverr", null, false, true, ms, "no image bytes");
        throw new ChallengeError(url);
      }
      this.limiter.recordSuccess();
      this.record(url, "flaresolverr", 200, true, false, ms, image.strategy);
      log.debug(`cover fetched via FlareSolverr ${image.strategy} (${image.bytes.length} bytes)`);
      return { url, status: 200, bytes: image.bytes, contentType: image.contentType };
    } catch (error) {
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (error instanceof ChallengeError || error instanceof CooldownError) throw error;
      this.limiter.recordFailure();
      this.record(url, "flaresolverr", null, false, false, ms, String(error));
      throw error;
    }
  }

  /** Ask FlareSolverr to solve a challenge for the origin and keep the resulting cookies. */
  async refreshClearance(): Promise<boolean> {
    if (!this.flareConfigured) return false;
    if (this.limiter.inCooldown()) return this.jar.hasClearance();
    try {
      await this.limiter.acquire();
      const result = await this.flare.get(`${this.config.source.baseUrl}/`);
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);
      return this.jar.hasClearance();
    } catch (error) {
      log.warn(`clearance refresh failed: ${String(error)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.flare.destroy();
  }
}
