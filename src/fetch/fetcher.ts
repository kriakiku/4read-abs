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

/**
 * How long to skip doomed Bun `fetch` probes after Cloudflare rejects them. Clearance cookies
 * from FlareSolverr do not transfer (different TLS fingerprint), so once direct fails we stick
 * to the browser until this window elapses.
 */
const DIRECT_BLOCK_MS = 30 * 60_000;

export class Fetcher {
  readonly jar: CookieJar;
  readonly limiter: AdaptiveLimiter;
  private readonly flare: FlareSolverrClient;
  /** When set, skip direct origin probes and go straight to FlareSolverr. */
  private directBlockedUntil = 0;

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

  private preferFlareFirst(): boolean {
    if (!this.flareConfigured) return false;
    if (this.config.flaresolverr.mode === "always") return true;
    return Date.now() < this.directBlockedUntil;
  }

  private blockDirectProbes(reason: string): void {
    if (!this.flareConfigured) return;
    const until = Date.now() + DIRECT_BLOCK_MS;
    if (until > this.directBlockedUntil) {
      this.directBlockedUntil = until;
      log.info(`skipping direct fetches for ${Math.round(DIRECT_BLOCK_MS / 60_000)}m (${reason})`);
    }
  }

  private userAgent(): string {
    return this.jar.userAgent ?? this.config.source.userAgent;
  }

  private browserHeaders(options: {
    referer?: string;
    accept?: string;
    purpose?: "document" | "playlist";
  } = {}): Record<string, string> {
    const purpose = options.purpose ?? "document";
    const headers: Record<string, string> = {
      "user-agent": this.userAgent(),
      accept:
        options.accept ??
        (purpose === "playlist"
          ? "*/*"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
      "accept-language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-fetch-dest": purpose === "playlist" ? "empty" : "document",
      "sec-fetch-mode": purpose === "playlist" ? "cors" : "navigate",
      "sec-fetch-site": options.referer ? "same-origin" : "none",
    };
    if (purpose === "document") {
      headers["sec-fetch-user"] = "?1";
      headers["upgrade-insecure-requests"] = "1";
    }
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    if (options.referer) headers.referer = options.referer;
    return headers;
  }

  private record(url: string, strategy: Strategy | null, status: number | null, ok: boolean, challenge: boolean, ms: number, error?: string): void {
    try {
      this.db
        .query(
          "insert into fetch_log (at, url, strategy, status, ok, challenge, ms, error) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(nowIso(), url, strategy, status, ok ? 1 : 0, challenge ? 1 : 0, Math.round(ms), error ?? null);
    } catch (error) {
      // Tests (and shutdown) may close the DB while an in-flight fetch still finishes.
      log.debug(`fetch_log write skipped: ${String(error)}`);
    }
  }

  /**
   * Make sure the jar has a PHPSESSID from 4read before playlist/media calls.
   * Hits `pageUrl` (article page) once when missing; soft-fails so audio can still try.
   */
  async ensurePhpSession(pageUrl: string): Promise<boolean> {
    if (this.jar.phpSessionId()) return true;
    try {
      await this.getText(pageUrl);
    } catch (error) {
      log.debug(`PHPSESSID warm-up failed for ${pageUrl}: ${String(error)}`);
      return Boolean(this.jar.phpSessionId());
    }
    return Boolean(this.jar.phpSessionId());
  }

  /**
   * Fetch a page as text. Tries a plain request first (cheap when the origin allows it) and
   * escalates to FlareSolverr on a challenge. Once Bun's TLS fingerprint is rejected, further
   * direct probes are skipped for a while — clearance cookies cannot be reused across JA3s.
   */
  async getText(
    url: string,
    options: { referer?: string; accept?: string; purpose?: "document" | "playlist" } = {},
  ): Promise<TextResult> {
    // Cooldown only blocks hammering the origin directly. FlareSolverr is a different client
    // and is how we keep crawling while Bun's fingerprint is rejected.
    if (this.limiter.inCooldown() && !this.flareConfigured) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const flareFirst = this.preferFlareFirst() || this.limiter.inCooldown();
    const headers = this.browserHeaders(options);

    if (!flareFirst) {
      await this.limiter.acquire();
      const started = Bun.nanoseconds();
      try {
        const response = await fetch(url, {
          headers,
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

        this.record(url, "direct", response.status, false, true, ms);
        log.debug(`challenge on direct fetch of ${url}`);
        if (this.flareConfigured) {
          // Expected on this source: do not burn the consecutive-challenge budget.
          this.blockDirectProbes("Cloudflare challenge on Bun fetch");
        } else {
          this.limiter.recordChallenge();
        }
      } catch (error) {
        const ms = (Bun.nanoseconds() - started) / 1e6;
        if (error instanceof Error && error.name === "ChallengeError") throw error;
        this.limiter.recordFailure();
        this.record(url, "direct", null, false, false, ms, String(error));
        if (!this.flareConfigured) throw error;
        log.debug(`direct fetch failed (${String(error)}), trying FlareSolverr`);
        this.blockDirectProbes("direct fetch error");
      }
    }

    if (!this.flareConfigured) {
      throw new ChallengeError(url);
    }

    // FlareSolverr runs its own browser; still serialise to avoid piling up sessions, but do
    // not wait out an origin cooldown that only applies to Bun's fingerprint.
    await this.limiter.acquire({ ignoreCooldown: true });
    const started = Bun.nanoseconds();
    try {
      // Always forward the jar (cf_clearance, PHPSESSID, viewed_ids, …) and merge whatever
      // Chrome returns so PHPSESSID survives across playlist fetches.
      const result = await this.flare.get(url, {
        cookies: this.jar.list(),
        headers: flareHeadersFrom(headers),
      });
      const ms = (Bun.nanoseconds() - started) / 1e6;
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);

      if (looksLikeChallenge(result.status, result.body)) {
        this.limiter.recordChallenge();
        this.record(url, "flaresolverr", result.status, false, true, ms);
        throw new ChallengeError(url);
      }
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
   * Fetch binary content (covers, audio tracks, …). Bun's TLS fingerprint cannot reuse
   * FlareSolverr clearance cookies, so a challenged direct download falls back to fetching
   * inside FlareSolverr's Chrome (download API; image URLs may also use a screenshot).
   */
  async getBinary(
    url: string,
    options: { referer?: string; purpose?: "image" | "media" } = {},
  ): Promise<BinaryResult> {
    if (this.limiter.inCooldown() && !this.flareConfigured) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const purpose = options.purpose ?? "image";

    const attemptDirect = async (): Promise<BinaryResult | "challenged"> => {
      await this.limiter.acquire();

      const started = Bun.nanoseconds();
      const headers = this.browserHeaders({ referer: options.referer });
      if (purpose === "media") {
        headers.accept = "audio/mpeg,audio/*,application/octet-stream,*/*;q=0.8";
        headers["sec-fetch-dest"] = "audio";
      } else {
        headers.accept = "image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8";
        headers["sec-fetch-dest"] = "image";
      }
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
        this.record(url, "direct", response.status, false, true, ms);
        return "challenged";
      }
      this.limiter.recordSuccess();
      this.record(url, "direct", response.status, true, false, ms);
      return { url, status: response.status, bytes, contentType };
    };

    const flareFirst = this.preferFlareFirst() || this.limiter.inCooldown();

    if (!flareFirst) {
      try {
        const first = await attemptDirect();
        if (first !== "challenged") return first;
        if (this.flareConfigured) {
          this.blockDirectProbes(`Cloudflare challenge on ${purpose} fetch`);
        } else {
          this.limiter.recordChallenge();
        }
      } catch (error) {
        if (error instanceof CooldownError) throw error;
        log.debug(`direct binary fetch failed (${String(error)}), trying FlareSolverr browser`);
        if (this.flareConfigured) this.blockDirectProbes(`direct ${purpose} fetch error`);
      }
    }

    if (!this.flareConfigured) throw new ChallengeError(url);

    await this.limiter.acquire({ ignoreCooldown: true });
    const started = Bun.nanoseconds();
    try {
      // Audio must not fall back to a PNG screenshot of the URL.
      const file =
        purpose === "media" ? await this.flare.fetchDownload(url) : await this.flare.fetchImage(url);
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (!file) {
        this.limiter.recordChallenge();
        this.record(url, "flaresolverr", null, false, true, ms, "no file bytes");
        throw new ChallengeError(url);
      }
      this.limiter.recordSuccess();
      this.record(url, "flaresolverr", 200, true, false, ms, file.strategy);
      log.debug(`binary fetched via FlareSolverr ${file.strategy} (${file.bytes.length} bytes)`);
      return { url, status: 200, bytes: file.bytes, contentType: file.contentType };
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
    try {
      await this.limiter.acquire({ ignoreCooldown: true });
      const result = await this.flare.get(`${this.config.source.baseUrl}/`);
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);
      this.blockDirectProbes("clearance refresh (Bun cannot reuse cookies)");
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

/** Headers FlareSolverr will forward; skip Cookie (passed separately) and hop-by-hop noise. */
function flareHeadersFrom(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "cookie" || lower === "host" || lower === "content-length") continue;
    out[key] = value;
  }
  return out;
}
