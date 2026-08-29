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

interface FlareSolution {
  url: string;
  status: number;
  cookies?: FlareCookie[];
  userAgent?: string;
  headers?: Record<string, string>;
  response?: string;
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
}

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

  async get(url: string): Promise<FlareResult> {
    await this.ensureSession();
    const payload: Record<string, unknown> = {
      cmd: "request.get",
      url,
      maxTimeout: this.maxTimeoutMs,
    };
    if (this.session) payload.session = this.session;

    // Allow slack over maxTimeout: FlareSolverr counts only the in-browser wait.
    let result = await this.command(payload, this.maxTimeoutMs + 15_000);

    // A stale session id makes every request fail; drop it and retry once without one.
    if (result.status !== "ok" && this.session) {
      log.warn(`retrying without session after error: ${result.message ?? "unknown"}`);
      this.session = null;
      delete payload.session;
      result = await this.command(payload, this.maxTimeoutMs + 15_000);
    }

    if (result.status !== "ok" || !result.solution) {
      throw new Error(`FlareSolverr error: ${result.message ?? "no solution"}`);
    }

    const solution = result.solution;
    return {
      status: solution.status ?? 0,
      body: solution.response ?? "",
      cookies: (solution.cookies ?? []).map((c) => ({
        name: c.name,
        value: c.value,
        expires: c.expires,
      })),
      userAgent: solution.userAgent,
    };
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
