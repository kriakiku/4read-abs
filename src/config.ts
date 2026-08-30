import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

export const SUBSCRIPTION_TYPES = ["author", "narrator", "series", "genre", "tag"] as const;
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];

const subscriptionSchema = z.object({
  type: z.enum(SUBSCRIPTION_TYPES),
  value: z.string().min(1),
  /** Optional human note, ignored by the engine. */
  note: z.string().optional(),
  enabled: z.boolean().default(true),
});

const pathMappingSchema = z.object({
  /** Path as Audiobookshelf reports it. */
  from: z.string().min(1),
  /** Same location as this process sees it. */
  to: z.string().min(1),
});

// Sections use `prefault` rather than `default`: zod v4 hands back a `default` value as-is,
// so an omitted section would arrive empty instead of filled with its field defaults.
export const configSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8480),
    })
    .prefault({}),

  paths: z
    .object({
      data: z.string().default("./data"),
      staging: z.string().default("./staging"),
      /** Where the Audiobookshelf library is mounted for this process. */
      absLibrary: z.string().default(""),
    })
    .prefault({}),

  source: z
    .object({
      baseUrl: z.string().default("https://4read.org"),
      /** Floor for the delay between requests; the limiter backs off above this on challenges. */
      minIntervalMs: z.number().int().min(0).default(5000),
      maxIntervalMs: z.number().int().min(0).default(120_000),
      /** Cooldown after a challenge that could not be solved. */
      challengeCooldownMs: z.number().int().min(0).default(600_000),
      requestTimeoutMs: z.number().int().min(1000).default(45_000),
      userAgent: z
        .string()
        .default(
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        ),
    })
    .prefault({}),

  flaresolverr: z
    .object({
      /** Full endpoint, e.g. http://127.0.0.1:8191/v1 */
      url: z.string().default(""),
      mode: z.enum(["auto", "always", "never"]).default("auto"),
      maxTimeoutMs: z.number().int().min(1000).default(180_000),
      /** Reuse a FlareSolverr session so clearance survives between requests. */
      useSession: z.boolean().default(true),
    })
    .prefault({}),

  audiobookshelf: z
    .object({
      url: z.string().default(""),
      apiKey: z.string().default(""),
      /** Empty means every book library. */
      libraryIds: z.array(z.string()).default([]),
      pathMappings: z.array(pathMappingSchema).default([]),
      /** Rescan an item after its sidecar changes so the change lands immediately. */
      triggerScan: z.boolean().default(true),
      /** Rewrites tags inside the audio files themselves. Off by default. */
      embedIntoAudioFiles: z.boolean().default(false),
    })
    .prefault({}),

  audio: z
    .object({
      /**
       * Timeouts and size floor for `{source.baseUrl}/m33u2/{id}-{slug}.m3u` track downloads
       * when Accept prepares a book / during library sync.
       */
      playlistTimeoutMs: z.number().int().min(1000).default(30_000),
      /** Per-track CDN download. 4h @ 128kbps ≈ 230MB; slow links need a long wall clock. */
      trackTimeoutMs: z.number().int().min(1000).default(3_600_000),
      /** How many CDN mp3s to download at once within one book (ENV: AUDIO_TRACK_CONCURRENCY). */
      trackConcurrency: z.number().int().min(1).max(32).default(5),
      minFileBytes: z.number().int().min(1).default(1024),
    })
    .prefault({}),

  sync: z
    .object({
      /**
       * fill-empty     - only set fields Audiobookshelf has left empty
       * overwrite-ours - replace values we wrote before, leave manual edits alone
       * overwrite-all  - always write our values
       */
      writePolicy: z.enum(["fill-empty", "overwrite-ours", "overwrite-all"]).default("overwrite-ours"),
      folderTemplate: z.string().default("{author}/{series}/{title}"),
      /** Media files are linked; small metadata files are always copied. */
      linkMode: z.enum(["hardlink", "copy"]).default("hardlink"),
      onCrossDevice: z.enum(["copy", "error"]).default("copy"),
      language: z.string().default("ukr"),
      tagPrefix: z.string().default("4read"),
      /** Minimum title/author similarity before an unlabelled item is auto-linked. */
      matchThreshold: z.number().min(0).max(1).default(0.86),
    })
    .prefault({}),

  narrators: z
    .object({
      /** Ordered: earlier entries win when the same book exists in several readings. */
      prefer: z.array(z.string()).default([]),
      block: z.array(z.string()).default([]),
    })
    .prefault({}),

  subscriptions: z.array(subscriptionSchema).default([]),

  schedule: z
    .object({
      /** Sitemap poll interval. Zero disables the timer. */
      incrementalMinutes: z.number().int().min(0).default(60),
      /**
       * Slowly fetch detail pages for subscription matches and queued books only.
       * The full sitemap catalogue is never detail-crawled.
       */
      backfillEnabled: z.boolean().default(true),
      backfillBatch: z.number().int().min(0).default(25),
      syncMinutes: z.number().int().min(0).default(180),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;

export const DEFAULT_CONFIG_PATH = process.env.CONFIG_FILE ?? "./config.yaml";

/** Fully resolved defaults (same shape as a parsed empty document). */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Environment always wins over the file. Secrets are expected to arrive this way so
 * they never end up in the YAML the web editor round-trips.
 */
function applyEnv(config: Config): Config {
  const c = config;

  c.server.host = process.env.HOST ?? c.server.host;
  c.server.port = envInt("PORT") ?? c.server.port;
  c.logLevel = (process.env.LOG_LEVEL as Config["logLevel"]) ?? c.logLevel;

  c.paths.data = process.env.DATA_DIR ?? c.paths.data;
  c.paths.staging = process.env.STAGING_DIR ?? c.paths.staging;
  c.paths.absLibrary = process.env.ABS_LIBRARY_DIR ?? c.paths.absLibrary;

  c.source.minIntervalMs = envInt("SOURCE_MIN_INTERVAL_MS") ?? c.source.minIntervalMs;
  c.source.baseUrl = process.env.SOURCE_BASE_URL ?? c.source.baseUrl;

  c.flaresolverr.url = process.env.FLARESOLVERR_URL ?? c.flaresolverr.url;
  c.flaresolverr.mode =
    (process.env.FLARESOLVERR_MODE as Config["flaresolverr"]["mode"]) ?? c.flaresolverr.mode;
  c.flaresolverr.maxTimeoutMs = envInt("FLARESOLVERR_MAX_TIMEOUT_MS") ?? c.flaresolverr.maxTimeoutMs;
  c.flaresolverr.useSession = envBool("FLARESOLVERR_USE_SESSION") ?? c.flaresolverr.useSession;

  c.audiobookshelf.url = process.env.ABS_URL ?? c.audiobookshelf.url;
  c.audiobookshelf.apiKey = process.env.ABS_API_KEY ?? c.audiobookshelf.apiKey;

  c.audio.trackTimeoutMs = envInt("AUDIO_TRACK_TIMEOUT_MS") ?? c.audio.trackTimeoutMs;
  c.audio.trackConcurrency = envInt("AUDIO_TRACK_CONCURRENCY") ?? c.audio.trackConcurrency;

  // Normalise the base URL once so URL joining is predictable everywhere else.
  c.source.baseUrl = c.source.baseUrl.replace(/\/+$/, "");
  c.audiobookshelf.url = c.audiobookshelf.url.replace(/\/+$/, "");
  return c;
}

export function parseConfigText(text: string): Config {
  const raw = text.trim() === "" ? {} : parseYaml(text);
  return configSchema.parse(raw ?? {});
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): { config: Config; text: string; path: string } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  return { config: applyEnv(parseConfigText(text)), text, path };
}

export async function saveConfigText(text: string, path = DEFAULT_CONFIG_PATH): Promise<Config> {
  // Validate before touching the file so a bad edit cannot break the next start.
  const parsed = parseConfigText(text);
  // Persist the compact form so unused / default keys do not accumulate on disk.
  const toWrite = compactConfigText(text);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  await Bun.write(path, toWrite.length > 0 ? `${toWrite}\n` : "");
  return applyEnv(parsed);
}

/** Config for the editor, with anything secret stripped out. */
export function redactConfigText(text: string): string {
  return text.replace(/^(\s*apiKey\s*:\s*).+$/gim, "$1\"***\"");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.some((key, index) => key !== keysB[index])) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

const SUBSCRIPTION_ITEM_DEFAULTS: Record<string, unknown> = { enabled: true };
const SUBSCRIPTION_ITEM_KEYS = new Set(["type", "value", "note", "enabled"]);

function pruneSubscriptionItem(item: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(item)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!SUBSCRIPTION_ITEM_KEYS.has(key)) continue;
    if (key === "enabled" && value === SUBSCRIPTION_ITEM_DEFAULTS.enabled) continue;
    if (key === "note" && (value === undefined || value === null || value === "")) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drop keys that are not part of the schema and values that equal schema defaults.
 * Used for the web editor so operators only see (and save) meaningful overrides.
 */
function pruneAgainstDefaults(value: unknown, defaults: unknown, path: string[] = []): unknown | undefined {
  if (deepEqual(value, defaults)) return undefined;

  if (Array.isArray(value)) {
    if (path[path.length - 1] === "subscriptions") {
      const items = value
        .map((item) => pruneSubscriptionItem(item))
        .filter((item): item is Record<string, unknown> => item !== undefined);
      return items.length > 0 ? items : undefined;
    }
    // pathMappings and string lists: keep as-is when non-default
    return value;
  }

  if (!isPlainObject(value) || !isPlainObject(defaults)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    if (!(key in value)) continue;
    const pruned = pruneAgainstDefaults(value[key], defaults[key], [...path, key]);
    if (pruned !== undefined) out[key] = pruned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * YAML for the UI: unknown sections (e.g. legacy hardcover/ai) removed, defaults omitted.
 * Invalid documents are returned unchanged so the editor can still show a broken file.
 */
export function compactConfigText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";

  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
    // Reject documents that would not load; keep original text editable.
    parseConfigText(text);
  } catch {
    return text;
  }

  if (!isPlainObject(raw)) return "";

  const pruned = pruneAgainstDefaults(raw, defaultConfig() as unknown as Record<string, unknown>);
  if (pruned === undefined) return "";
  return stringifyYaml(pruned, { lineWidth: 0 }).trimEnd();
}
