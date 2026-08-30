import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfigText, redactConfigText, saveConfigText } from "../src/config.ts";

const KEYS = [
  "ABS_URL",
  "ABS_API_KEY",
  "HARDCOVER_API_KEY",
  "FLARESOLVERR_URL",
  "FLARESOLVERR_MODE",
  "STAGING_DIR",
  "DATA_DIR",
  "ABS_LIBRARY_DIR",
  "PORT",
  "SOURCE_MIN_INTERVAL_MS",
  "OPENAI_API_KEY",
  "OPENCODE_GO_API_KEY",
  "AI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "COVERS_PREFER",
];

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("configuration", () => {
  test("an empty document yields usable defaults", () => {
    const config = parseConfigText("");

    expect(config.server.port).toBe(8480);
    // Loopback by default: the UI has no authentication.
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.source.minIntervalMs).toBe(5000);
    expect(config.sync.writePolicy).toBe("overwrite-ours");
    expect(config.narrators.prefer).toEqual([]);
    expect(config.subscriptions).toEqual([]);
    expect(config.flaresolverr.mode).toBe("auto");
  });

  test("a partial section keeps the other defaults in that section", () => {
    const config = parseConfigText("sync:\n  writePolicy: overwrite-all\n");
    expect(config.sync.writePolicy).toBe("overwrite-all");
    expect(config.sync.linkMode).toBe("hardlink");
    expect(config.sync.tagPrefix).toBe("4read");
  });

  test("legacy createFolders key in yaml is ignored", () => {
    const config = parseConfigText("sync:\n  createFolders: false\n  writePolicy: overwrite-all\n");
    expect(config.sync.writePolicy).toBe("overwrite-all");
    expect((config.sync as { createFolders?: boolean }).createFolders).toBeUndefined();
  });

  test("subscriptions default to enabled", () => {
    const config = parseConfigText("subscriptions:\n  - type: series\n    value: dune\n");
    expect(config.subscriptions[0]).toEqual({ type: "series", value: "dune", enabled: true });
  });

  test("an unknown subscription type is rejected", () => {
    expect(() => parseConfigText("subscriptions:\n  - type: publisher\n    value: x\n")).toThrow();
  });

  test("environment variables override the file", () => {
    setEnv({
      ABS_URL: "http://abs.local:13378/",
      ABS_API_KEY: "secret",
      FLARESOLVERR_URL: "http://flare:8191/v1",
      STAGING_DIR: "/data/staging",
      PORT: "9999",
      SOURCE_MIN_INTERVAL_MS: "12000",
    });

    const config = parseConfigTextWithEnv("audiobookshelf:\n  url: http://ignored\n");

    // Trailing slashes are trimmed so URL joining stays predictable.
    expect(config.audiobookshelf.url).toBe("http://abs.local:13378");
    expect(config.audiobookshelf.apiKey).toBe("secret");
    expect(config.flaresolverr.url).toBe("http://flare:8191/v1");
    expect(config.paths.staging).toBe("/data/staging");
    expect(config.server.port).toBe(9999);
    expect(config.source.minIntervalMs).toBe(12000);
  });

  test("a Hardcover key switches the integration on", () => {
    setEnv({ HARDCOVER_API_KEY: "hc-token" });
    const config = parseConfigTextWithEnv("");
    expect(config.hardcover.enabled).toBe(true);
    expect(config.hardcover.apiKey).toBe("hc-token");
  });

  test("Hardcover stays off without a key", () => {
    setEnv({});
    expect(parseConfigTextWithEnv("").hardcover.enabled).toBe(false);
  });

  test("OpenAI / OpenCode Go key enables AI matching defaults", () => {
    setEnv({ OPENAI_API_KEY: "sk-test" });
    const config = parseConfigTextWithEnv("");
    expect(config.ai.enabled).toBe(true);
    expect(config.ai.apiKey).toBe("sk-test");
    expect(config.ai.model).toBe("mimo-v2.5");
    expect(config.covers.prefer).toBe("hardcover-first");
  });

  test("COVERS_PREFER overrides cover policy", () => {
    setEnv({ COVERS_PREFER: "hardcover-only" });
    expect(parseConfigTextWithEnv("").covers.prefer).toBe("hardcover-only");
  });

  test("audio section keeps timeout defaults and uses source.baseUrl", () => {
    setEnv({});
    const config = parseConfigTextWithEnv("");
    expect(config.audio.playlistTimeoutMs).toBe(30_000);
    expect(config.audio.trackTimeoutMs).toBe(3_600_000);
    expect(config.audio.trackConcurrency).toBe(5);
    expect(config.source.baseUrl).toBe("https://4read.org");
  });

  test("AUDIO_TRACK_CONCURRENCY overrides yaml", () => {
    setEnv({ AUDIO_TRACK_CONCURRENCY: "8" });
    expect(parseConfigTextWithEnv("").audio.trackConcurrency).toBe(8);
  });

  test("saving validates first and leaves a broken file unwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-abs-config-"));
    try {
      const path = join(dir, "config.yaml");
      setEnv({});

      await saveConfigText("server:\n  port: 8123\n", path);
      expect(loadConfig(path).config.server.port).toBe(8123);

      await expect(saveConfigText("server:\n  port: not-a-number\n", path)).rejects.toThrow();
      // The previously good file must survive a rejected edit.
      expect(loadConfig(path).config.server.port).toBe(8123);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is not an error", () => {
    setEnv({});
    const loaded = loadConfig(join(tmpdir(), "definitely-absent-4read-abs.yaml"));
    expect(loaded.text).toBe("");
    expect(loaded.config.server.port).toBe(8480);
  });

  test("redaction hides api keys from the editor", () => {
    const text = "audiobookshelf:\n  apiKey: super-secret\nhardcover:\n  apiKey: other\n";
    const redacted = redactConfigText(text);
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("other");
    expect(redacted).toContain("apiKey:");
  });
});

/** `loadConfig` is what applies environment overrides, so route through a temp file. */
function parseConfigTextWithEnv(text: string) {
  const path = join(tmpdir(), `4read-abs-env-${Bun.hash(`${text}${Math.random()}`).toString(16)}.yaml`);
  writeFileSync(path, text);
  try {
    return loadConfig(path).config;
  } finally {
    rmSync(path, { force: true });
  }
}
