import { getMeta, setMeta, type Db } from "../db.ts";

export interface StoredCookie {
  name: string;
  value: string;
  expires?: number;
  /** Host-only or leading-dot domain from Set-Cookie / FlareSolverr. */
  domain?: string;
}

interface JarState {
  cookies: StoredCookie[];
  userAgent?: string;
  updatedAt?: string;
}

const META_KEY = "cookie_jar";

/** Strip leading dot; lowercase. Empty string = no domain (legacy jar entries). */
export function normalizeCookieDomain(domain: string | undefined): string {
  if (!domain) return "";
  return domain.replace(/^\./, "").toLowerCase();
}

/** True when a cookie Domain attribute should be sent to `host`. */
export function cookieDomainMatchesHost(cookieDomain: string | undefined, host: string): boolean {
  const d = normalizeCookieDomain(cookieDomain);
  if (!d) return false;
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Single-process cookie jar persisted in SQLite. Cloudflare clearance is expensive to
 * obtain, so it has to survive restarts.
 *
 * Cookies are keyed by (domain, name) so `cf_clearance` for 4read.org and reasd.org
 * can coexist. Legacy entries without `domain` apply only to `primaryHost`.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();
  private ua: string | undefined;
  private primaryHost: string | null = null;

  constructor(private readonly db: Db, primaryHost?: string | null) {
    if (primaryHost) this.primaryHost = primaryHost.toLowerCase();
    const raw = getMeta(db, META_KEY);
    if (!raw) return;
    try {
      const state = JSON.parse(raw) as JarState;
      for (const cookie of state.cookies ?? []) {
        if (!cookie.name) continue;
        this.cookies.set(this.key(cookie.name, cookie.domain), {
          name: cookie.name,
          value: cookie.value,
          expires: cookie.expires,
          domain: cookie.domain,
        });
      }
      this.ua = state.userAgent;
      this.dropExpired();
    } catch {
      // A corrupt jar is not worth failing over; start clean.
    }
  }

  /** Bind undomain (legacy) cookies to this host for filtering. */
  setPrimaryHost(host: string | null | undefined): void {
    this.primaryHost = host ? host.toLowerCase() : null;
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

  hasClearance(forUrl?: string): boolean {
    return this.list(forUrl).some((c) => c.name === "cf_clearance" && Boolean(c.value));
  }

  /** PHP session id from the last successful 4read response, if we have one. */
  phpSessionId(): string | null {
    const cookies = this.list(this.primaryHost ? `https://${this.primaryHost}/` : undefined);
    const value = cookies.find((c) => c.name === "PHPSESSID")?.value?.trim();
    return value ? value : null;
  }

  get(name: string, forUrl?: string): string | null {
    const value = this.list(forUrl).find((c) => c.name === name)?.value;
    return value && value.length > 0 ? value : null;
  }

  set(cookies: StoredCookie[]): void {
    for (const cookie of cookies) {
      if (!cookie.name) continue;
      const key = this.key(cookie.name, cookie.domain);
      // FlareSolverr sometimes returns an empty PHPSESSID in a partial dump — keep the last good one.
      if (cookie.name === "PHPSESSID" && !cookie.value?.trim()) {
        const existing = this.cookies.get(key) ?? [...this.cookies.values()].find((c) => c.name === "PHPSESSID");
        if (existing?.value?.trim()) continue;
      }
      // Session cookies often arrive with expires=-1; treat those as non-expiring.
      const expires =
        cookie.expires !== undefined && cookie.expires > 0 ? cookie.expires : undefined;
      this.cookies.set(key, {
        name: cookie.name,
        value: cookie.value,
        expires,
        domain: cookie.domain,
      });
    }
    this.dropExpired();
    this.persist();
  }

  /** Parse `set-cookie` headers from a direct response (optional response URL for Domain). */
  absorbSetCookie(headers: Headers, responseUrl?: string): void {
    const raw: string[] = [...(headers.getSetCookie?.() ?? [])];
    // Older runtimes may only expose a single joined set-cookie header.
    if (raw.length === 0) {
      const single = headers.get("set-cookie");
      if (single) raw.push(single);
    }
    if (raw.length === 0) return;
    let fallbackHost: string | undefined;
    if (responseUrl) {
      try {
        fallbackHost = new URL(responseUrl).hostname;
      } catch {
        fallbackHost = undefined;
      }
    }
    const parsed: StoredCookie[] = [];
    for (const line of raw) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expires: number | undefined;
      let domain: string | undefined;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        const key = k?.trim().toLowerCase();
        if (key === "expires" && v) {
          const ts = Date.parse(v.trim());
          if (Number.isFinite(ts)) expires = Math.floor(ts / 1000);
        }
        if (key === "max-age" && v) {
          const secs = Number.parseInt(v.trim(), 10);
          if (Number.isFinite(secs)) expires = Math.floor(Date.now() / 1000) + secs;
        }
        if (key === "domain" && v) {
          domain = v.trim();
        }
      }
      if (!domain && fallbackHost) domain = fallbackHost;
      parsed.push({ name, value, expires, domain });
    }
    if (parsed.length) this.set(parsed);
  }

  /**
   * Cookie header for Bun fetch. Without `forUrl`, uses primary host (source site).
   * Never mixes CDN clearance into 4read requests or vice versa.
   */
  header(forUrl?: string): string | undefined {
    const cookies = this.list(forUrl);
    if (cookies.length === 0) return undefined;
    // Deduplicate by name (host-only + Domain= may both match); last wins.
    const byName = new Map<string, string>();
    for (const c of cookies) byName.set(c.name, c.value);
    return [...byName.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }

  /**
   * Snapshot for FlareSolverr `cookies` payloads.
   * When `forUrl` is set, only cookies that belong on that host (CDN vs source).
   */
  list(forUrl?: string): StoredCookie[] {
    this.dropExpired();
    let host: string | null = null;
    if (forUrl) {
      try {
        host = new URL(forUrl).hostname.toLowerCase();
      } catch {
        host = null;
      }
    } else if (this.primaryHost) {
      host = this.primaryHost;
    }

    const out: StoredCookie[] = [];
    for (const cookie of this.cookies.values()) {
      if (!host) {
        out.push({ ...cookie });
        continue;
      }
      if (cookie.domain) {
        if (cookieDomainMatchesHost(cookie.domain, host)) out.push({ ...cookie });
        continue;
      }
      // Legacy undomain entries: only the primary (4read) host — never the CDN.
      if (this.primaryHost && (host === this.primaryHost || host.endsWith(`.${this.primaryHost}`))) {
        out.push({ ...cookie });
      }
    }
    return out;
  }

  clear(): void {
    this.cookies.clear();
    this.persist();
  }

  private key(name: string, domain?: string): string {
    return `${normalizeCookieDomain(domain)}\0${name}`;
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
