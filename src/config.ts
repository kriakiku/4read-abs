import { parse as parseYaml } from "yaml";
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

  hardcover: z
    .object({
      enabled: z.boolean().default(false),
      apiKey: z.string().default(""),
      endpoint: z.string().default("https://api.hardcover.app/v1/graphql"),
      /** Minimum heuristic score before a Hardcover book id is accepted as 1:1. */
      acceptScore: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),

  covers: z
    .object({
      /**
       * hardcover-first - Hardcover CDN, then 4read (Cloudflare-gated)
       * hardcover-only  - never download covers from 4read
       * source          - only 4read (legacy behaviour)
       */
      prefer: z.enum(["hardcover-first", "hardcover-only", "source"]).default("hardcover-first"),
    })
    .prefault({}),

  ai: z
    .object({
      /**
       * Optional OpenAI-compatible API for ambiguous Hardcover matches only.
       * Recommended OpenCode Go model: mimo-v2.5 (cheapest solid chat model on the plan).
       */
      enabled: z.boolean().default(false),
      apiKey: z.string().default(""),
      baseUrl: z.string().default("https://opencode.ai/zen/go/v1"),
      model: z.string().default("mimo-v2.5"),
      /** Call AI only when the best heuristic score is in [minScore, maxScore). */
      minScore: z.number().min(0).max(1).default(0.55),
      maxScore: z.number().min(0).max(1).default(0.85),
      maxCallsPerHour: z.number().int().min(0).default(10),
      maxCallsPerDay: z.number().int().min(0).default(50),
    })
    .prefault({}),

  audio: z
    .object({
      /**
       * Timeouts and size floor for `{source.baseUrl}/m33u2/{slug}.m3u` track downloads
       * during sync / createFolders.
       */
      playlistTimeoutMs: z.number().int().min(1000).default(30_000),
      trackTimeoutMs: z.number().int().min(1000).default(120_000),
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
      /** Create a folder in the library for books that are not there yet. */
      createFolders: z.boolean().default(false),
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
      /** Slowly fetch detail pages. Off for unrelated sitemap entries unless backfillAll. */
      backfillEnabled: z.boolean().default(true),
      /**
       * When false (default), only fetch details for books that match a subscription or are
       * already in the news queue. When true, walk the whole pending catalogue by lastmod.
       */
      backfillAll: z.boolean().default(false),
      backfillBatch: z.number().int().min(0).default(25),
      syncMinutes: z.number().int().min(0).default(180),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;

export const DEFAULT_CONFIG_PATH = process.env.CONFIG_FILE ?? "./config.yaml";

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

  const hardcoverKey = process.env.HARDCOVER_API_KEY;
  if (hardcoverKey) {
    c.hardcover.apiKey = hardcoverKey;
    if (envBool("HARDCOVER_ENABLED") !== false) c.hardcover.enabled = true;
  }

  const aiKey = process.env.OPENAI_API_KEY ?? process.env.OPENCODE_GO_API_KEY ?? process.env.AI_API_KEY;
  if (aiKey) {
    c.ai.apiKey = aiKey;
    if (envBool("AI_ENABLED") !== false) c.ai.enabled = true;
  }
  c.ai.baseUrl = process.env.OPENAI_BASE_URL ?? process.env.AI_BASE_URL ?? c.ai.baseUrl;
  c.ai.model = process.env.OPENAI_MODEL ?? process.env.AI_MODEL ?? c.ai.model;

  const coverPrefer = process.env.COVERS_PREFER as Config["covers"]["prefer"] | undefined;
  if (coverPrefer === "hardcover-first" || coverPrefer === "hardcover-only" || coverPrefer === "source") {
    c.covers.prefer = coverPrefer;
  }

  // Normalise the base URL once so URL joining is predictable everywhere else.
  c.source.baseUrl = c.source.baseUrl.replace(/\/+$/, "");
  c.audiobookshelf.url = c.audiobookshelf.url.replace(/\/+$/, "");
  c.ai.baseUrl = c.ai.baseUrl.replace(/\/+$/, "");
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
  mkdirSync(dirname(resolve(path)), { recursive: true });
  await Bun.write(path, text);
  return applyEnv(parsed);
}

/** Config for the editor, with anything secret stripped out. */
export function redactConfigText(text: string): string {
  return text.replace(/^(\s*apiKey\s*:\s*).+$/gim, "$1\"***\"");
}
