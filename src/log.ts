export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/** Ring buffer of recent lines so the web UI can show what the daemon is doing. */
const recent: string[] = [];
const RECENT_MAX = 500;

export function recentLogs(limit = 200): string[] {
  return recent.slice(-limit);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  recent.push(line);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  if (LEVELS[level] < threshold) return;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
