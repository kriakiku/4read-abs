import { logger } from "../log.ts";
import type { StoredCookie } from "./cookies.ts";

const log = logger("flaresolverr");

interface FlareCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
}

interface FlareDownload {
  filename?: string;
  mime?: string;
  mime_type?: string;
  data?: string;
  encoded_data?: string;
}

interface FlareSolution {
  url: string;
  status: number;
  cookies?: FlareCookie[];
  userAgent?: string;
  headers?: Record<string, string>;
  response?: string;
  screenshot?: string;
  download?: FlareDownload | FlareDownload[];
  har?: unknown;
}

interface FlareResponse {
  status: "ok" | "error";
  message?: string;
  session?: string;
  solution?: FlareSolution;
}

export interface FlareResult {
  status: number;
  body: string;
  cookies: StoredCookie[];
  userAgent?: string;
  /** Present when the FlareSolverr build supports `recordHar: true`. */
  har?: unknown;
}

export interface FlareFileResult {
  bytes: Uint8Array;
  contentType: string;
  strategy: "download" | "screenshot";
}

/** @deprecated Use FlareFileResult */
export type FlareImageResult = FlareFileResult;

/**
 * Client for the FlareSolverr v1 API. FlareSolverr drives a real browser, so it can pass
 * the managed challenge; we then harvest its clearance cookies for cheap direct requests.
 */
export class FlareSolverrClient {
  private session: string | null = null;
  private sessionAttempted = false;

  constructor(
    private readonly endpoint: string,
    private readonly maxTimeoutMs: number,
    private readonly useSession: boolean,
  ) {}

  get configured(): boolean {
    return this.endpoint.length > 0;
  }

  private async command(payload: Record<string, unknown>, timeoutMs: number): Promise<FlareResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`FlareSolverr HTTP ${response.status}`);
    }
    return (await response.json()) as FlareResponse;
  }

  private async ensureSession(): Promise<void> {
    if (!this.useSession || this.session || this.sessionAttempted) return;
    this.sessionAttempted = true;
    try {
      const result = await this.command({ cmd: "sessions.create" }, this.maxTimeoutMs);
      if (result.status === "ok" && result.session) {
        this.session = result.session;
        log.info(`created session ${this.session}`);
      } else {
        log.warn(`could not create session: ${result.message ?? "unknown error"}`);
      }
    } catch (error) {
      log.warn(`session creation failed: ${String(error)}`);
    }
  }

  private async requestGet(url: string, extra: Record<string, unknown> = {}): Promise<FlareResponse> {
    await this.ensureSession();
    const payload: Record<string, unknown> = {
      cmd: "request.get",
      url,
      maxTimeout: this.maxTimeoutMs,
      // Covers must load; some deployments set DISABLE_MEDIA=true globally.
      disableMedia: false,
      ...extra,
    };
    if (this.session) payload.session = this.session;

    let result = await this.command(payload, this.maxTimeoutMs + 15_000);

    if (result.status !== "ok" && this.session) {
      log.warn(`retrying without session after error: ${result.message ?? "unknown"}`);
      this.session = null;
      delete payload.session;
      result = await this.command(payload, this.maxTimeoutMs + 15_000);
    }

    return result;
  }

  async get(
    url: string,
    options: {
      cookies?: StoredCookie[];
      headers?: Record<string, string>;
      /** Extra seconds after the challenge so the player can fire its m3u request. */
      waitInSeconds?: number;
      /** Ask Chrome to record a HAR (supported on some FlareSolverr builds). */
      recordHar?: boolean;
    } = {},
  ): Promise<FlareResult> {
    log.info(`Chrome GET ${url}`);
    const started = Date.now();
    const extra: Record<string, unknown> = {};
    if (options.cookies?.length) {
      extra.cookies = options.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
      }));
    }
    if (options.headers && Object.keys(options.headers).length > 0) {
      extra.headers = options.headers;
    }
    if (options.waitInSeconds && options.waitInSeconds > 0) {
      extra.waitInSeconds = options.waitInSeconds;
    }
    if (options.recordHar) {
      extra.recordHar = true;
    }
    const result = await this.requestGet(url, extra);
    if (result.status !== "ok" || !result.solution) {
      throw new Error(`FlareSolverr error: ${result.message ?? "no solution"}`);
    }

    const solution = result.solution;
    log.info(
      `Chrome GET done in ${Math.round((Date.now() - started) / 1000)}s → HTTP ${solution.status ?? 0} (${(solution.response ?? "").length} bytes)` +
        (solution.har ? ", har captured" : ""),
    );
    return {
      status: solution.status ?? 0,
      body: solution.response ?? "",
      cookies: (solution.cookies ?? []).map((c) => ({
        name: c.name,
        value: c.value,
        expires: c.expires,
      })),
      userAgent: solution.userAgent,
      har: solution.har,
    };
  }

  /**
   * Fetch a file inside FlareSolverr's browser via patched `download: true` (base64 bytes).
   * Works for images, audio, playlists, and other files that Chrome downloads rather than renders.
   * Navigating to `.m3u` via plain `request.get` often leaves HTML in `solution.response`
   * (previous page / empty document) — download mode is required for the real body.
   */
  async fetchDownload(
    url: string,
    options: {
      cookies?: StoredCookie[];
      headers?: Record<string, string>;
      /** Allow small text payloads (m3u playlists are often under 64 bytes of header + few URLs). */
      minBytes?: number;
    } = {},
  ): Promise<FlareFileResult | null> {
    const minBytes = options.minBytes ?? 64;
    try {
      const extra: Record<string, unknown> = { download: true };
      if (options.cookies?.length) {
        extra.cookies = options.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          ...(c.expires !== undefined ? { expires: c.expires } : {}),
        }));
      }
      if (options.headers && Object.keys(options.headers).length > 0) {
        extra.headers = options.headers;
      }
      log.info(`Chrome DOWNLOAD ${url}`);
      const started = Date.now();
      const downloaded = await this.requestGet(url, extra);
      const file = normaliseDownload(downloaded.solution?.download);
      if (downloaded.status === "ok" && file) {
        const bytes = decodeBase64(file.data);
        const size = bytes?.length ?? 0;
        log.info(
          `Chrome DOWNLOAD done in ${Math.round((Date.now() - started) / 1000)}s → ${size} bytes` +
            (file.mime ? ` (${file.mime})` : ""),
        );
        if (bytes && bytes.length >= minBytes && !looksLikeHtml(bytes)) {
          return {
            bytes,
            contentType: file.mime || sniffContentType(bytes) || "application/octet-stream",
            strategy: "download",
          };
        }
        if (bytes && looksLikeHtml(bytes)) {
          log.warn(`Chrome DOWNLOAD for ${url} returned HTML (${size} bytes), not a file`);
        }
      } else {
        log.debug(
          `Chrome DOWNLOAD unavailable for ${url}: ${downloaded.message ?? "no download payload"}`,
        );
      }
    } catch (error) {
      log.debug(`FlareSolverr download mode unavailable: ${String(error)}`);
    }
    return null;
  }

  /**
   * Fetch an image inside FlareSolverr's browser (same TLS fingerprint + cookies that already
   * passed Cloudflare). Prefer patched download mode; fall back to a PNG screenshot.
   */
  async fetchImage(url: string): Promise<FlareFileResult | null> {
    const downloaded = await this.fetchDownload(url);
    if (downloaded) return downloaded;

    // Stock FlareSolverr: open the image URL in Chrome and screenshot the viewer.
    const shot = await this.requestGet(url, { returnScreenshot: true });
    if (shot.status !== "ok" || !shot.solution?.screenshot) {
      log.debug(`FlareSolverr screenshot failed: ${shot.message ?? "no screenshot"}`);
      return null;
    }
    const bytes = decodeBase64(shot.solution.screenshot);
    if (!bytes || bytes.length < 64) return null;
    return { bytes, contentType: "image/png", strategy: "screenshot" };
  }

  async destroy(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    this.session = null;
    try {
      await this.command({ cmd: "sessions.destroy", session }, 15_000);
      log.info(`destroyed session ${session}`);
    } catch (error) {
      log.debug(`session destroy failed: ${String(error)}`);
    }
  }
}

function normaliseDownload(
  download: FlareDownload | FlareDownload[] | undefined,
): { data: string; mime: string | null } | null {
  const entry = Array.isArray(download) ? download[0] : download;
  if (!entry) return null;
  const data = entry.data ?? entry.encoded_data;
  if (!data) return null;
  return { data, mime: entry.mime ?? entry.mime_type ?? null };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const trimmed = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
    return Uint8Array.from(Buffer.from(trimmed, "base64"));
  } catch {
    return null;
  }
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trim().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("_cf_chl");
}

function sniffContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
