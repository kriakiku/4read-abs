import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { CookieJar } from "../src/fetch/cookies.ts";
import { ChallengeError, CooldownError, Fetcher } from "../src/fetch/fetcher.ts";
import { AdaptiveLimiter } from "../src/fetch/limiter.ts";

/** The interstitial 4read.org serves to non-browser clients. */
const CHALLENGE_BODY = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><script>window._cf_chl_opt = {cRay: 'abc'};</script></body></html>`;

const PAGE_BODY = `<html><body><ul class="pmovie__list"><li>ok</li></ul></body></html>`;

interface Harness {
  db: Db;
  dir: string;
  origin: ReturnType<typeof Bun.serve>;
  flare: ReturnType<typeof Bun.serve>;
  originRequests: Array<{ path: string; cookie: string | null }>;
  flareRequests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) await harness.close();
  }
});

/**
 * Stands up a fake origin plus a fake FlareSolverr so the escalation path can be exercised
 * without touching the real site.
 */
async function harness(options: {
  /** Number of leading requests that answer with a challenge. */
  challengeFirst?: number;
  /** Serve a challenge to every request that arrives without clearance. */
  requireClearance?: boolean;
  flareBroken?: boolean;
} = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "4read-abs-fetch-"));
  const db = openDb(dir);
  const originRequests: Harness["originRequests"] = [];
  const flareRequests: Harness["flareRequests"] = [];
  let challengesLeft = options.challengeFirst ?? 0;

  const origin = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const cookie = request.headers.get("cookie");
      originRequests.push({ path: url.pathname, cookie });

      const hasClearance = cookie?.includes("cf_clearance=") ?? false;
      const challenge = challengesLeft > 0 || (options.requireClearance === true && !hasClearance);
      if (challenge) {
        if (challengesLeft > 0) challengesLeft -= 1;
        return new Response(CHALLENGE_BODY, {
          status: 403,
          headers: { "content-type": "text/html" },
        });
      }

      if (url.pathname.endsWith(".webp")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/webp" } });
      }
      return new Response(PAGE_BODY, { headers: { "content-type": "text/html" } });
    },
  });

  const flare = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as Record<string, unknown>;
      flareRequests.push(payload);

      if (options.flareBroken) {
        return Response.json({ status: "error", message: "browser exploded" });
      }
      if (payload.cmd === "sessions.create") {
        return Response.json({ status: "ok", session: "session-1" });
      }
      if (payload.cmd === "sessions.destroy") {
        return Response.json({ status: "ok" });
      }

      const target = String(payload.url ?? "");
      const cookies = [
        { name: "cf_clearance", value: "granted", expires: Math.floor(Date.now() / 1000) + 3600 },
        { name: "PHPSESSID", value: "abc" },
      ];

      // Stock FlareSolverr path for images: screenshot of the image viewer.
      if (payload.returnScreenshot && /\.(webp|png|jpe?g)(\?|$)/i.test(target)) {
        return Response.json({
          status: "ok",
          solution: {
            url: target,
            status: 200,
            response: "",
            userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
            cookies,
            // 1x1 PNG
            screenshot:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        });
      }

      return Response.json({
        status: "ok",
        solution: {
          url: target,
          status: 200,
          response: PAGE_BODY,
          userAgent: "Mozilla/5.0 (FlareSolverr Chrome)",
          cookies,
        },
      });
    },
  });

  const result: Harness = {
    db,
    dir,
    origin,
    flare,
    originRequests,
    flareRequests,
    close: async () => {
      db.close();
      await origin.stop(true);
      await flare.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(result);
  return result;
}

function config(h: Harness, overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse({
    paths: { data: h.dir },
    source: { baseUrl: `http://localhost:${h.origin.port}`, minIntervalMs: 0, challengeCooldownMs: 50 },
    flaresolverr: { url: `http://localhost:${h.flare.port}/`, maxTimeoutMs: 5000 },
    ...overrides,
  });
}

describe("cookie jar", () => {
  test("survives a restart and reports clearance", async () => {
    const h = await harness();
    const jar = new CookieJar(h.db);
    expect(jar.hasClearance()).toBe(false);

    jar.set([{ name: "cf_clearance", value: "abc", expires: Math.floor(Date.now() / 1000) + 600 }]);
    jar.setUserAgent("UA/1.0");

    const reopened = new CookieJar(h.db);
    expect(reopened.hasClearance()).toBe(true);
    expect(reopened.userAgent).toBe("UA/1.0");
    expect(reopened.header()).toContain("cf_clearance=abc");
  });

  test("drops expired cookies", async () => {
    const h = await harness();
    const jar = new CookieJar(h.db);
    jar.set([{ name: "cf_clearance", value: "old", expires: Math.floor(Date.now() / 1000) - 10 }]);
    expect(jar.hasClearance()).toBe(false);
  });

  test("absorbs set-cookie headers", async () => {
    const h = await harness();
    const jar = new CookieJar(h.db);
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/; Max-Age=600");
    headers.append("set-cookie", "b=2; Path=/");
    jar.absorbSetCookie(headers);
    expect(jar.header()).toContain("a=1");
    expect(jar.header()).toContain("b=2");
  });

  test("appendViewedId accumulates book ids without duplicates", async () => {
    const h = await harness();
    const jar = new CookieJar(h.db);
    jar.appendViewedId(5546);
    jar.appendViewedId(8054);
    jar.appendViewedId(5546);
    expect(jar.header()).toBe("viewed_ids=5546,8054");
  });
});

describe("adaptive limiter", () => {
  test("interval grows on challenges and decays on success", () => {
    const limiter = new AdaptiveLimiter({ minIntervalMs: 100, maxIntervalMs: 10_000, challengeCooldownMs: 1000 });
    expect(limiter.state().intervalMs).toBe(100);

    limiter.recordChallenge();
    expect(limiter.state().intervalMs).toBeGreaterThan(100);

    for (let i = 0; i < 20; i += 1) limiter.recordSuccess();
    expect(limiter.state().intervalMs).toBe(100);
  });

  test("consecutive challenges trigger a cooldown that expires", async () => {
    const limiter = new AdaptiveLimiter({ minIntervalMs: 0, maxIntervalMs: 1000, challengeCooldownMs: 40 });
    limiter.recordChallenge();
    limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(false);

    limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(true);

    await Bun.sleep(60);
    expect(limiter.inCooldown()).toBe(false);
  });

  test("a success clears the cooldown", () => {
    const limiter = new AdaptiveLimiter({ minIntervalMs: 0, maxIntervalMs: 1000, challengeCooldownMs: 10_000 });
    for (let i = 0; i < 3; i += 1) limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(true);
    limiter.recordSuccess();
    expect(limiter.inCooldown()).toBe(false);
  });

  test("requests are spaced by the interval", async () => {
    const limiter = new AdaptiveLimiter({ minIntervalMs: 40, maxIntervalMs: 1000, challengeCooldownMs: 0 });
    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  test("acquire re-waits when a previous caller just entered cooldown", async () => {
    const limiter = new AdaptiveLimiter({
      minIntervalMs: 1,
      maxIntervalMs: 20,
      challengeCooldownMs: 80,
      cooldownAfterChallenges: 1,
    });
    await limiter.acquire();
    limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(true);

    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  test("acquire can skip cooldown for FlareSolverr traffic", async () => {
    const limiter = new AdaptiveLimiter({
      minIntervalMs: 0,
      maxIntervalMs: 20,
      challengeCooldownMs: 60_000,
      cooldownAfterChallenges: 1,
    });
    await limiter.acquire();
    limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(true);

    const started = Date.now();
    await limiter.acquire({ ignoreCooldown: true });
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("fetcher", () => {
  test("a plain request is used when nothing challenges", async () => {
    const h = await harness();
    const fetcher = new Fetcher(h.db, config(h));

    const result = await fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`);
    expect(result.strategy).toBe("direct");
    expect(result.body).toContain("pmovie__list");
    expect(h.flareRequests).toHaveLength(0);
    await fetcher.close();
  });

  test("a challenge escalates to FlareSolverr and sticks to it", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h));

    const first = await fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`);
    expect(first.strategy).toBe("flaresolverr");
    expect(fetcher.jar.hasClearance()).toBe(true);
    // FlareSolverr reports the browser's user agent; later probes reuse it when needed.
    expect(fetcher.jar.userAgent).toContain("FlareSolverr");

    // Bun cannot reuse cf_clearance (different TLS fingerprint), so once direct is challenged
    // we skip further origin probes and stay on FlareSolverr.
    const second = await fetcher.getText(`http://localhost:${h.origin.port}/2-y.html`);
    expect(second.strategy).toBe("flaresolverr");
    expect(h.originRequests.length).toBe(1);
    // Doomed direct probes must not burn the consecutive-challenge cooldown budget.
    expect(fetcher.limiter.state().challenges).toBe(0);
    expect(fetcher.limiter.inCooldown()).toBe(false);
    await fetcher.close();
  });

  test("a session is created once and reused", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h, {
      paths: { data: h.dir },
      flaresolverr: { url: `http://localhost:${h.flare.port}/`, mode: "always", useSession: true },
      source: { baseUrl: `http://localhost:${h.origin.port}`, minIntervalMs: 0 },
    }));

    await fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`);
    await fetcher.getText(`http://localhost:${h.origin.port}/2-y.html`);

    const creates = h.flareRequests.filter((request) => request.cmd === "sessions.create");
    const gets = h.flareRequests.filter((request) => request.cmd === "request.get");
    expect(creates).toHaveLength(1);
    expect(gets).toHaveLength(2);
    expect(gets.every((request) => request.session === "session-1")).toBe(true);

    await fetcher.close();
    expect(h.flareRequests.some((request) => request.cmd === "sessions.destroy")).toBe(true);
  });

  test("mode always skips the plain request entirely", async () => {
    const h = await harness();
    const fetcher = new Fetcher(h.db, config(h, {
      paths: { data: h.dir },
      source: { baseUrl: `http://localhost:${h.origin.port}`, minIntervalMs: 0 },
      flaresolverr: { url: `http://localhost:${h.flare.port}/`, mode: "always" },
    }));

    const result = await fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`);
    expect(result.strategy).toBe("flaresolverr");
    expect(h.originRequests).toHaveLength(0);
    await fetcher.close();
  });

  test("without FlareSolverr a challenge surfaces as ChallengeError", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h, {
      paths: { data: h.dir },
      source: { baseUrl: `http://localhost:${h.origin.port}`, minIntervalMs: 0 },
      flaresolverr: { url: "", mode: "auto" },
    }));

    await expect(fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`)).rejects.toThrow(ChallengeError);
    expect(fetcher.limiter.state().challenges).toBe(1);
    await fetcher.close();
  });

  test("a broken FlareSolverr does not hide the failure", async () => {
    const h = await harness({ requireClearance: true, flareBroken: true });
    const fetcher = new Fetcher(h.db, config(h));
    await expect(fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`)).rejects.toThrow();
    await fetcher.close();
  });

  test("covers are fetched via FlareSolverr browser when direct is blocked", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h));

    const cover = await fetcher.getBinary(`http://localhost:${h.origin.port}/uploads/x.webp`);
    expect(cover.bytes.length).toBeGreaterThan(64);
    expect(cover.contentType).toBe("image/png");
    expect(h.flareRequests.some((request) => request.returnScreenshot === true)).toBe(true);
    await fetcher.close();
  });

  test("cover fetches still use FlareSolverr during origin cooldown", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h, {
      paths: { data: h.dir },
      source: {
        baseUrl: `http://localhost:${h.origin.port}`,
        minIntervalMs: 0,
        challengeCooldownMs: 10_000,
      },
      flaresolverr: { url: `http://localhost:${h.flare.port}/`, maxTimeoutMs: 5000 },
    }));

    for (let i = 0; i < 3; i += 1) fetcher.limiter.recordChallenge();
    expect(fetcher.limiter.inCooldown()).toBe(true);

    const before = h.originRequests.length;
    const cover = await fetcher.getBinary(`http://localhost:${h.origin.port}/uploads/x.webp`);
    expect(cover.bytes.length).toBeGreaterThan(64);
    // Origin must not be probed while we are in cooldown — go straight to FlareSolverr.
    expect(h.originRequests.length).toBe(before);
    expect(h.flareRequests.some((request) => request.returnScreenshot === true)).toBe(true);
    await fetcher.close();
  });

  test("without FlareSolverr, cooldown still blocks cover fetches", async () => {
    const h = await harness({ requireClearance: true });
    const fetcher = new Fetcher(h.db, config(h, {
      paths: { data: h.dir },
      source: {
        baseUrl: `http://localhost:${h.origin.port}`,
        minIntervalMs: 0,
        challengeCooldownMs: 10_000,
      },
      flaresolverr: { url: "", mode: "auto" },
    }));

    for (let i = 0; i < 3; i += 1) fetcher.limiter.recordChallenge();
    await expect(fetcher.getBinary(`http://localhost:${h.origin.port}/uploads/x.webp`)).rejects.toThrow(
      CooldownError,
    );
    await fetcher.close();
  });

  test("every attempt is written to the fetch log", async () => {
    const h = await harness();
    const fetcher = new Fetcher(h.db, config(h));
    await fetcher.getText(`http://localhost:${h.origin.port}/1-x.html`);

    const rows = h.db.query<{ url: string; ok: number; strategy: string }, []>("select url, ok, strategy from fetch_log").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(1);
    expect(rows[0]!.strategy).toBe("direct");
    await fetcher.close();
  });
});
