import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactConfigText,
  loadConfig,
  parseConfigText,
  redactConfigText,
  saveConfigText,
} from "../src/config.ts";

const KEYS = [
  "ABS_URL",
  "ABS_API_KEY",
  "FLARESOLVERR_URL",
  "FLARESOLVERR_MODE",
  "STAGING_DIR",
  "DATA_DIR",
  "ABS_LIBRARY_DIR",
  "PORT",
  "SOURCE_MIN_INTERVAL_MS",
  "AUDIO_TRACK_CONCURRENCY",
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

  test("legacy hardcover / ai / covers sections are ignored", () => {
    const config = parseConfigText(
      [
        "hardcover:",
        "  enabled: true",
        "  apiKey: hc",
        "ai:",
        "  enabled: true",
        "covers:",
        "  prefer: hardcover-only",
        "server:",
        "  port: 9000",
      ].join("\n"),
    );
    expect(config.server.port).toBe(9000);
    expect((config as { hardcover?: unknown }).hardcover).toBeUndefined();
    expect((config as { ai?: unknown }).ai).toBeUndefined();
    expect((config as { covers?: unknown }).covers).toBeUndefined();
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
    const text = "audiobookshelf:\n  apiKey: super-secret\n";
    const redacted = redactConfigText(text);
    expect(redacted).not.toContain("super-secret");
    expect(redacted).toContain("apiKey:");
  });

  test("compactConfigText drops defaults and unused sections", () => {
    const text = [
      "logLevel: info",
      "server:",
      "  host: 127.0.0.1",
      "  port: 9001",
      "hardcover:",
      "  enabled: true",
      "  apiKey: hc-token",
      "ai:",
      "  enabled: true",
      "covers:",
      "  prefer: hardcover-first",
      "subscriptions:",
      "  - type: series",
      "    value: dune",
      "    enabled: true",
      "  - type: author",
      "    value: Christie",
      "    enabled: false",
    ].join("\n");

    const compact = compactConfigText(text);
    expect(compact).toContain("port: 9001");
    expect(compact).not.toContain("logLevel");
    expect(compact).not.toContain("127.0.0.1");
    expect(compact).not.toContain("hardcover");
    expect(compact).not.toContain("ai:");
    expect(compact).not.toContain("covers");
    expect(compact).toContain("value: dune");
    expect(compact).not.toMatch(/value: dune[\s\S]*enabled: true/);
    expect(compact).toContain("enabled: false");
    // Round-trip still loads with defaults filled in.
    expect(parseConfigText(compact).server.port).toBe(9001);
    expect(parseConfigText(compact).subscriptions).toHaveLength(2);
  });

  test("compactConfigText leaves invalid yaml untouched", () => {
    const broken = "server:\n  port: not-a-number\n";
    expect(compactConfigText(broken)).toBe(broken);
  });

  test("saveConfigText persists the compact form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "4read-abs-compact-"));
    try {
      const path = join(dir, "config.yaml");
      setEnv({});
      await saveConfigText("logLevel: info\nserver:\n  port: 8123\nhardcover:\n  enabled: true\n", path);
      const onDisk = await Bun.file(path).text();
      expect(onDisk).toContain("port: 8123");
      expect(onDisk).not.toContain("logLevel");
      expect(onDisk).not.toContain("hardcover");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
