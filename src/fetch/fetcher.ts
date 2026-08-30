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
  har?: unknown;
  /** m3u body from in-page `executeJs` fetch during book warm-up. */
  playlistBody?: string;
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

/** True when a playlist response is clearly an HTML document rather than M3U text. */
function looksLikeHtmlPlaylistMiss(body: string): boolean {
  const head = body.trim().slice(0, 256).toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.includes("<head") ||
    head.includes("just a moment")
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
  /**
   * Serialise whole-book audio pipelines (book→home→m3u→tracks). Accept can start
   * prepare-A and prepare-B as separate jobs; without this lock they interleave Chrome
   * navigations and burn each other's signed CDN URLs.
   */
  private audioGate: Promise<void> = Promise.resolve();
  /** Book HTML URL whose book→home chain is currently established in Chrome. */
  private audioContextBook: string | null = null;
  /** True when the shared Chrome tab is on the site homepage (safe Referer, no Playerjs). */
  private audioContextOnHome = false;
  /** When set, skip direct origin probes and go straight to FlareSolverr. */
  private directBlockedUntil = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    let primaryHost: string | null = null;
    try {
      primaryHost = new URL(config.source.baseUrl).hostname;
    } catch {
      primaryHost = null;
    }
    this.jar = new CookieJar(db, primaryHost);
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
   * Run one book's audio work alone. Concurrent Accept jobs must not share Chrome mid-pipeline.
   */
  async runExclusiveAudio<T>(task: () => Promise<T>): Promise<T> {
    const run = this.audioGate.then(async () => {
      try {
        return await task();
      } finally {
        this.audioContextBook = null;
        this.audioContextOnHome = false;
      }
    });
    this.audioGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  homeUrl(): string {
    return `${this.config.source.baseUrl.replace(/\/+$/, "")}/`;
  }

  /**
   * Chrome: open book HTML (kill Playerjs, no m3u fetch), then navigate to the site homepage.
   * Homepage has no player — safe place to executeJs-fetch the m3u and to set Referer for
   * CDN downloads. Call again whenever the book context changes (another book, or lost home).
   */
  async establishBookHomeContext(bookPageUrl: string): Promise<TextResult | null> {
    if (!this.flareConfigured) {
      try {
        return await this.getText(bookPageUrl, { chrome: true });
      } catch (error) {
        log.debug(`book page load failed for ${bookPageUrl}: ${String(error)}`);
        return null;
      }
    }

    log.info(`Chrome book→home context for ${bookPageUrl}`);
    let book: TextResult | null = null;
    try {
      book = await this.getText(bookPageUrl, {
        chrome: true,
        disableMedia: true,
        executeJs: killPlayerExecuteJs(),
      });
    } catch (error) {
      log.debug(`book page open failed for ${bookPageUrl}: ${String(error)}`);
    }

    try {
      await this.getText(this.homeUrl(), {
        chrome: true,
        disableMedia: true,
      });
      this.audioContextBook = bookPageUrl;
      this.audioContextOnHome = true;
      log.info(`Chrome now on homepage (Referer base) after ${bookPageUrl}`);
    } catch (error) {
      log.warn(`Chrome homepage navigation failed: ${String(error)}`);
      this.audioContextBook = null;
      this.audioContextOnHome = false;
    }
    return book;
  }

  /** Ensure Chrome is on the homepage before a CDN download (Referer: 4read.org/, no player). */
  async landOnHome(): Promise<void> {
    if (!this.flareConfigured) return;
    if (this.audioContextOnHome) return;
    log.info(`Chrome land on homepage ${this.homeUrl()}`);
    await this.getText(this.homeUrl(), {
      chrome: true,
      disableMedia: true,
    });
    this.audioContextOnHome = true;
  }

  /** In-page fetch of the m3u from the homepage (same origin, no Playerjs). */
  async fetchPlaylistFromHome(playlistUrl: string): Promise<string | null> {
    if (!this.flareConfigured) return null;
    await this.landOnHome();
    try {
      log.info(`Chrome executeJs m3u from homepage → ${playlistUrl}`);
      const result = await this.flare.get(this.homeUrl(), {
        cookies: this.jar.list(this.homeUrl()),
        disableMedia: true,
        executeJs: playlistFetchExecuteJs(playlistUrl),
      });
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);
      this.audioContextOnHome = true;
      const body = playlistBodyFromExecuteJs(result.executeJsResult);
      if (body) {
        log.info(`playlist via homepage executeJs (${body.length} bytes)`);
        return body;
      }
      log.warn(`homepage executeJs returned no m3u for ${playlistUrl}`);
      return null;
    } catch (error) {
      log.warn(`homepage m3u fetch failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * @deprecated Prefer establishBookHomeContext + fetchPlaylistFromHome.
   */
  async warmBookPage(
    pageUrl: string,
    options: { fetchPlaylistUrl?: string | null } = {},
  ): Promise<TextResult | null> {
    const book = await this.establishBookHomeContext(pageUrl);
    if (options.fetchPlaylistUrl) {
      const body = await this.fetchPlaylistFromHome(options.fetchPlaylistUrl);
      if (book && body) {
        return { ...book, playlistBody: body };
      }
    }
    return book;
  }

  /**
   * Fetch a page as text. Tries a plain request first (cheap when the origin allows it) and
   * escalates to FlareSolverr on a challenge. Once Bun's TLS fingerprint is rejected, further
   * direct probes are skipped for a while — clearance cookies cannot be reused across JA3s.
   *
   * `chrome: true` or `purpose: "playlist"` skips Bun fetch and loads via FlareSolverr Chrome
   * when configured (m3u must not use the direct TLS fingerprint).
   */
  async getText(
    url: string,
    options: {
      referer?: string;
      accept?: string;
      purpose?: "document" | "playlist";
      /** Force FlareSolverr Chrome when available (used for m3u + its warm-up page). */
      chrome?: boolean;
      waitInSeconds?: number;
      recordHar?: boolean;
      /** flaresolverr-go: block Media (and images/CSS/fonts) during this navigation. */
      disableMedia?: boolean;
      executeJs?: string;
    } = {},
  ): Promise<TextResult> {
    // Cooldown only blocks hammering the origin directly. FlareSolverr is a different client
    // and is how we keep crawling while Bun's fingerprint is rejected.
    if (this.limiter.inCooldown() && !this.flareConfigured) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const wantChrome = Boolean(options.chrome || options.purpose === "playlist");
    const flareFirst =
      (wantChrome && this.flareConfigured) || this.preferFlareFirst() || this.limiter.inCooldown();
    const headers = this.browserHeaders(options);

    if (wantChrome && this.flareConfigured) {
      log.debug(`Chrome-only fetch for ${url}`);
    }

    if (!flareFirst) {
      if (wantChrome) {
        log.debug(`FlareSolverr not configured — falling back to direct fetch for ${url}`);
      }
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
      // Forward host-matching jar cookies (never plant 4read cf_clearance on CDN).
      const result = await this.flare.get(url, {
        cookies: this.jar.list(url),
        headers: flareHeadersFrom(headers),
        waitInSeconds: options.waitInSeconds,
        recordHar: options.recordHar,
        disableMedia: options.disableMedia,
        executeJs: options.executeJs,
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
      const playlistBody = playlistBodyFromExecuteJs(result.executeJsResult);
      if (playlistBody) {
        log.info(`playlist via executeJs (${playlistBody.length} bytes) during page load`);
      }
      return {
        url,
        status: result.status,
        body: result.body,
        strategy: "flaresolverr",
        har: result.har,
        playlistBody: playlistBody ?? undefined,
      };
    } catch (error) {
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (error instanceof ChallengeError) throw error;
      this.limiter.recordFailure();
      this.record(url, "flaresolverr", null, false, false, ms, String(error));
      throw error;
    }
  }

  /**
   * Fetch an m3u playlist body.
   * Stock FlareSolverr v2 cannot return `.m3u` via navigate (page_source stays previous HTML)
   * and ignores `download: true`. After warming the book page we try a direct Bun GET with
   * Chrome cookies/UA/Referer — `/m33u2/` is often not behind the HTML challenge.
   * Patched Flare builds: `download: true` is used when direct fails.
   */
  async getPlaylistText(
    url: string,
    options: { referer?: string } = {},
  ): Promise<TextResult> {
    if (this.limiter.inCooldown() && !this.flareConfigured) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const headers = this.browserHeaders({
      referer: options.referer,
      accept: "*/*",
      purpose: "playlist",
    });

    // Direct first — do not honour directBlockedUntil (that flag is for CF HTML; m3u may work).
    await this.limiter.acquire({ ignoreCooldown: true });
    const directStarted = Bun.nanoseconds();
    try {
      log.info(`playlist: direct GET with page cookies → ${url}`);
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.config.audio.playlistTimeoutMs),
      });
      const body = await response.text();
      const ms = (Bun.nanoseconds() - directStarted) / 1e6;
      this.jar.absorbSetCookie(response.headers);

      if (response.ok && !looksLikeChallenge(response.status, body, response.headers) && !looksLikeHtmlPlaylistMiss(body)) {
        this.limiter.recordSuccess();
        this.record(url, "direct", response.status, true, false, ms);
        log.info(`playlist via direct GET (${body.length} bytes) ${url}`);
        return { url: response.url || url, status: response.status, body, strategy: "direct" };
      }
      this.record(
        url,
        "direct",
        response.status,
        false,
        true,
        ms,
        response.ok ? "html instead of m3u" : `HTTP ${response.status}`,
      );
      log.warn(
        `playlist direct GET failed (${response.status}, ${body.length} bytes, html=${looksLikeHtmlPlaylistMiss(body)}) for ${url}`,
      );
    } catch (error) {
      const ms = (Bun.nanoseconds() - directStarted) / 1e6;
      if (error instanceof CooldownError) throw error;
      this.limiter.recordFailure();
      this.record(url, "direct", null, false, false, ms, String(error));
      log.warn(`playlist direct GET error for ${url}: ${String(error)}`);
    }

    if (!this.flareConfigured) {
      throw new ChallengeError(url);
    }

    await this.limiter.acquire({ ignoreCooldown: true });
    const started = Bun.nanoseconds();
    const file = await this.flare.fetchDownload(url, {
      cookies: this.jar.list(url),
      headers: flareHeadersFrom(headers),
      minBytes: 8,
    });
    const ms = (Bun.nanoseconds() - started) / 1e6;
    if (file) {
      const body = new TextDecoder().decode(file.bytes);
      this.limiter.recordSuccess();
      this.record(url, "flaresolverr", 200, true, false, ms, "download");
      log.info(`playlist via Chrome download (${file.bytes.length} bytes) ${url}`);
      return { url, status: 200, body, strategy: "flaresolverr" };
    }
    this.record(url, "flaresolverr", null, false, false, ms, "download unavailable");
    log.warn(
      `playlist unavailable for ${url}: direct GET failed and FlareSolverr has no download:true (stock v2 returns previous HTML on .m3u navigate)`,
    );
    throw new ChallengeError(url);
  }

  /**
   * Fetch binary content (covers, audio tracks, …).
   *
   * Audio CDN (`reasd.org`) is plain nginx with Referer hotlink checks — not Cloudflare.
   * Bun GET with `Referer: https://4read.org/` works; FlareSolverr `download:true` navigates
   * then re-fetches and the second request loses the site Referer → nginx 403 HTML (~2966 bytes).
   *
   * Covers on the source host still escalate to FlareSolverr when Bun's TLS is challenged.
   */
  async getBinary(
    url: string,
    options: { referer?: string; purpose?: "image" | "media" } = {},
  ): Promise<BinaryResult> {
    const purpose = options.purpose ?? "image";
    if (purpose === "media") {
      return this.downloadMediaDirect(url, options.referer);
    }

    if (this.limiter.inCooldown() && !this.flareConfigured) {
      throw new CooldownError(this.limiter.cooldownRemainingMs());
    }

    const attemptDirect = async (): Promise<BinaryResult | "challenged"> => {
      await this.limiter.acquire();

      const started = Bun.nanoseconds();
      const headers = this.browserHeaders({ referer: options.referer });
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
      this.jar.absorbSetCookie(response.headers, url);

      if (response.status === 403 || response.status === 503 || response.status === 429) {
        this.record(url, "direct", response.status, false, true, ms);
        return "challenged";
      }
      if (!response.ok) {
        this.record(url, "direct", response.status, false, false, ms);
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
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
          this.blockDirectProbes(`Cloudflare challenge on image fetch`);
        } else {
          this.limiter.recordChallenge();
        }
      } catch (error) {
        if (error instanceof CooldownError) throw error;
        log.debug(`direct binary fetch failed (${String(error)}), trying FlareSolverr browser`);
        const text = String(error);
        if (!/TimeoutError|timed out|ECONNRESET|ENOTFOUND|fetch failed/i.test(text)) {
          if (this.flareConfigured) this.blockDirectProbes(`direct image fetch error`);
        }
      }
    }

    if (!this.flareConfigured) throw new ChallengeError(url);

    await this.limiter.acquire({ ignoreCooldown: true });
    const started = Bun.nanoseconds();
    try {
      const file = await this.flare.fetchImage(url);
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (!file) {
        this.limiter.recordFailure();
        this.record(url, "flaresolverr", null, false, false, ms, "no file bytes");
        throw new ChallengeError(url);
      }
      this.limiter.recordSuccess();
      this.record(url, "flaresolverr", 200, true, false, ms, file.strategy);
      log.info(`binary via FlareSolverr ${file.strategy} (${file.bytes.length} bytes) ${url}`);
      return { url, status: 200, bytes: file.bytes, contentType: file.contentType };
    } catch (error) {
      const ms = (Bun.nanoseconds() - started) / 1e6;
      if (error instanceof ChallengeError || error instanceof CooldownError) throw error;
      this.limiter.recordFailure();
      this.record(url, "flaresolverr", null, false, false, ms, String(error));
      throw error;
    }
  }

  /**
   * Audio CDN is nginx Referer hotlink (no Cloudflare). Always Bun GET with site Referer.
   * Do not route through FlareSolverr download:true — it re-fetches without the site Referer.
   */
  private async downloadMediaDirect(url: string, referer?: string): Promise<BinaryResult> {
    const ref = referer?.trim() || this.homeUrl();
    // CDN traffic must not wait out 4read.org Cloudflare cooldowns.
    await this.limiter.acquire({ ignoreCooldown: true });

    const started = Bun.nanoseconds();
    const headers = this.browserHeaders({ referer: ref, purpose: "playlist" });
    headers.accept = "audio/mpeg,audio/*,application/octet-stream,*/*;q=0.8";
    headers["sec-fetch-dest"] = "audio";
    headers["sec-fetch-mode"] = "no-cors";
    delete headers["upgrade-insecure-requests"];
    delete headers["sec-fetch-user"];
    // 4read cookies are useless on the CDN and can confuse debugging.
    delete headers.cookie;
    try {
      const mediaHost = new URL(url).hostname;
      const refHost = new URL(ref).hostname;
      headers["sec-fetch-site"] = mediaHost === refHost || mediaHost.endsWith(`.${refHost}`) ? "same-site" : "cross-site";
    } catch {
      headers["sec-fetch-site"] = "cross-site";
    }

    const timeoutMs = this.config.audio.trackTimeoutMs;
    log.info(`CDN track direct GET (Referer ${ref}, timeout ${Math.round(timeoutMs / 1000)}s) → ${url}`);
    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const contentType = response.headers.get("content-type");
      const ms = (Bun.nanoseconds() - started) / 1e6;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const head = new TextDecoder().decode(bytes.slice(0, 200)).toLowerCase();
      const html =
        head.includes("<!doctype") || head.includes("<html") || (contentType ?? "").includes("text/html");

      if (!response.ok || html) {
        this.record(url, "direct", response.status, false, false, ms, html ? "hotlink html" : undefined);
        log.warn(
          `CDN track rejected (HTTP ${response.status}, ${bytes.length} bytes, html=${html}) for ${url} — need Referer ${ref}`,
        );
        throw new Error(`CDN hotlink rejected (HTTP ${response.status}) for ${url}`);
      }

      this.limiter.recordSuccess();
      this.record(url, "direct", response.status, true, false, ms);
      log.info(`CDN track via direct GET (${bytes.length} bytes) ${url}`);
      return { url, status: response.status, bytes, contentType };
    } catch (error) {
      if (error instanceof CooldownError) throw error;
      if (error instanceof Error && error.message.startsWith("CDN hotlink")) throw error;
      const ms = (Bun.nanoseconds() - started) / 1e6;
      this.limiter.recordFailure();
      this.record(url, "direct", null, false, false, ms, String(error));
      throw error;
    }
  }

  /** Ask FlareSolverr to solve a challenge for the origin and keep the resulting cookies. */
  async refreshClearance(): Promise<boolean> {
    if (!this.flareConfigured) return false;
    try {
      await this.limiter.acquire({ ignoreCooldown: true });
      const home = this.homeUrl();
      const result = await this.flare.get(home);
      this.jar.setUserAgent(result.userAgent);
      if (result.cookies.length) this.jar.set(result.cookies);
      this.blockDirectProbes("clearance refresh (Bun cannot reuse cookies)");
      return this.jar.hasClearance(home);
    } catch (error) {
      log.warn(`clearance refresh failed: ${String(error)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.flare.destroy();
  }
}

/**
 * Headers FlareSolverr / flaresolverr-go will forward into Chrome.
 * Go's net/http (flaresolverr-go) rejects forbidden names: `sec-fetch-*`, `Referer`, Cookie, Host, …
 * Cookie is passed via the cookies field; Referer is not settable — rely on same-session navigation.
 */
export function flareHeadersFrom(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!FLARE_HEADER_ALLOW.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/** Only headers flaresolverr-go accepts on request.get (Go forbids Referer, sec-*, Cookie, Host, …). */
const FLARE_HEADER_ALLOW = new Set(["accept", "accept-language", "accept-encoding"]);

/**
 * Stub Playerjs / pause media while Chrome is briefly on the book HTML.
 * Do not fetch the m3u here — that happens from the homepage (no player).
 */
export function killPlayerExecuteJs(): string {
  return (
    `try{` +
    `window.Playerjs=function(){return{api:function(){}};};` +
    `document.querySelectorAll("audio,video").forEach(function(el){try{el.pause();el.removeAttribute("src");el.load();}catch(e){}});` +
    `}catch(e){}` +
    `return "ok"`
  );
}

/** In-page fetch of the m3u from the site homepage (same origin as /m33u2/…). */
export function playlistFetchExecuteJs(playlistUrl: string): string {
  return (
    `return fetch(${JSON.stringify(playlistUrl)},{credentials:"include",headers:{"Accept":"*/*"}})` +
    `.then(function(r){return r.text();})`
  );
}

function playlistBodyFromExecuteJs(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (looksLikeHtmlPlaylistMiss(trimmed)) return null;
  if (trimmed.startsWith("#EXTM3U") || /^https?:\/\//i.test(trimmed)) return trimmed;
  // Some bridges JSON-stringify the result.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const unquoted = JSON.parse(trimmed) as string;
      if (typeof unquoted === "string" && !looksLikeHtmlPlaylistMiss(unquoted)) return unquoted;
    } catch {
      // keep raw
    }
  }
  return trimmed;
}
