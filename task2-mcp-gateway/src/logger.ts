/**
 * Structured logger: one JSON object per line on stderr.
 *
 * stdout is reserved (the only stdout write in this task is the `--mint-token` CLI output), so
 * every diagnostic goes to stderr. Each line carries a timestamp, level, message and any fields
 * the caller adds; `child()` binds fields such as the per-request id so every line written while
 * handling one HTTP request can be correlated with the `x-request-id` returned to the caller.
 * The sink and clock are injectable so tests can capture lines (for example to assert that a
 * bearer token never appears in the log) without touching the real stderr.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  now?: () => Date;
  base?: LogFields;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < minRank) return;
    const entry = { time: now().toISOString(), level, msg, ...base, ...fields };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level, msg, logError: "unserializable fields" });
    }
    sink(line);
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything; handy as a default in tests. */
export const silentLogger: Logger = createLogger({ sink: () => {} });
