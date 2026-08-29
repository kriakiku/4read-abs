import { getMeta, setMeta, type Db } from "../db.ts";

export interface StoredCookie {
  name: string;
  value: string;
  expires?: number;
}

interface JarState {
  cookies: StoredCookie[];
  userAgent?: string;
  updatedAt?: string;
}

const META_KEY = "cookie_jar";

/**
 * Single-origin cookie jar persisted in SQLite. Cloudflare clearance is expensive to
 * obtain, so it has to survive restarts.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();
  private ua: string | undefined;

  constructor(private readonly db: Db) {
    const raw = getMeta(db, META_KEY);
    if (!raw) return;
    try {
      const state = JSON.parse(raw) as JarState;
      for (const cookie of state.cookies ?? []) this.cookies.set(cookie.name, cookie);
      this.ua = state.userAgent;
      this.dropExpired();
    } catch {
      // A corrupt jar is not worth failing over; start clean.
    }
  }

  get userAgent(): string | undefined {
    return this.ua;
  }

  setUserAgent(userAgent: string | undefined): void {
    if (userAgent && userAgent !== this.ua) {
      this.ua = userAgent;
      this.persist();
    }
  }

  hasClearance(): boolean {
    this.dropExpired();
    return this.cookies.has("cf_clearance");
  }

  set(cookies: StoredCookie[]): void {
    for (const cookie of cookies) {
      if (!cookie.name) continue;
      this.cookies.set(cookie.name, { name: cookie.name, value: cookie.value, expires: cookie.expires });
    }
    this.dropExpired();
    this.persist();
  }

  /** Parse `set-cookie` headers from a direct response. */
  absorbSetCookie(headers: Headers): void {
    const raw = headers.getSetCookie?.() ?? [];
    if (raw.length === 0) return;
    const parsed: StoredCookie[] = [];
    for (const line of raw) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expires: number | undefined;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        if (k?.trim().toLowerCase() === "expires" && v) {
          const ts = Date.parse(v.trim());
          if (Number.isFinite(ts)) expires = Math.floor(ts / 1000);
        }
        if (k?.trim().toLowerCase() === "max-age" && v) {
          const secs = Number.parseInt(v.trim(), 10);
          if (Number.isFinite(secs)) expires = Math.floor(Date.now() / 1000) + secs;
        }
      }
      parsed.push({ name, value, expires });
    }
    if (parsed.length) this.set(parsed);
  }

  header(): string | undefined {
    this.dropExpired();
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.values()].map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /**
   * Append a book id to the DLE `viewed_ids` cookie (comma-separated). The playlist endpoint
   * expects the article id to already be marked as viewed.
   */
  appendViewedId(sourceId: number): void {
    if (!Number.isFinite(sourceId) || sourceId <= 0) return;
    const id = String(Math.trunc(sourceId));
    const existing = this.cookies.get("viewed_ids")?.value ?? "";
    const ids = existing
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (!ids.includes(id)) ids.push(id);
    this.set([{ name: "viewed_ids", value: ids.join(",") }]);
  }

  /** Snapshot for FlareSolverr `cookies` payloads. */
  list(): StoredCookie[] {
    this.dropExpired();
    return [...this.cookies.values()].map((c) => ({ ...c }));
  }

  clear(): void {
    this.cookies.clear();
    this.persist();
  }

  private dropExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [name, cookie] of this.cookies) {
      if (cookie.expires !== undefined && cookie.expires > 0 && cookie.expires < now) {
        this.cookies.delete(name);
      }
    }
  }

  private persist(): void {
    const state: JarState = {
      cookies: [...this.cookies.values()],
      userAgent: this.ua,
      updatedAt: new Date().toISOString(),
    };
    setMeta(this.db, META_KEY, JSON.stringify(state));
  }
}
