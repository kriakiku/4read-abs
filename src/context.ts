import { AudiobookshelfClient } from "./abs/client.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { HardcoverClient } from "./enrich/hardcover.ts";
import { Fetcher } from "./fetch/fetcher.ts";
import { setLogLevel } from "./log.ts";

export interface JobStatus {
  name: string;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastResult: string | null;
  lastError: string | null;
}

export class AppContext {
  db: Db;
  config: Config;
  configText: string;
  configPath: string;
  fetcher: Fetcher;
  abs: AudiobookshelfClient;
  hardcover: HardcoverClient;
  readonly jobs = new Map<string, JobStatus>();
  readonly startedAt = new Date().toISOString();

  constructor(configPath?: string) {
    const loaded = loadConfig(configPath);
    this.config = loaded.config;
    this.configText = loaded.text;
    this.configPath = loaded.path;
    setLogLevel(this.config.logLevel);

    this.db = openDb(this.config.paths.data);
    this.fetcher = new Fetcher(this.db, this.config);
    this.abs = new AudiobookshelfClient(this.config.audiobookshelf.url, this.config.audiobookshelf.apiKey);
    this.hardcover = new HardcoverClient(this.db, this.config);
  }

  /** Rebuild everything that depends on config after an edit, keeping the database open. */
  reload(config: Config, configText: string): void {
    this.config = config;
    this.configText = configText;
    setLogLevel(config.logLevel);
    this.fetcher = new Fetcher(this.db, config);
    this.abs = new AudiobookshelfClient(config.audiobookshelf.url, config.audiobookshelf.apiKey);
    this.hardcover = new HardcoverClient(this.db, config);
  }

  jobStatus(name: string): JobStatus {
    let status = this.jobs.get(name);
    if (!status) {
      status = { name, running: false, startedAt: null, finishedAt: null, lastResult: null, lastError: null };
      this.jobs.set(name, status);
    }
    return status;
  }

  /** Runs a named job at most once at a time and records its outcome for the UI. */
  async runJob<T>(name: string, task: () => Promise<T>): Promise<T | null> {
    const status = this.jobStatus(name);
    if (status.running) return null;
    status.running = true;
    status.startedAt = new Date().toISOString();
    status.lastError = null;
    try {
      const result = await task();
      status.lastResult = typeof result === "string" ? result : JSON.stringify(result);
      return result;
    } catch (error) {
      status.lastError = String(error);
      throw error;
    } finally {
      status.running = false;
      status.finishedAt = new Date().toISOString();
    }
  }

  async close(): Promise<void> {
    await this.fetcher.close();
    this.db.close();
  }
}
