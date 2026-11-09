/**
 * Structured JSON-lines logger on stderr (stdout stays clean for piping). The gateway never passes
 * prompt or response text here, only ids, lengths, counts and timings, so logs are safe to ship to
 * a shared log store. The sink is injectable so tests can capture or silence output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, string | number | boolean | null | undefined | Record<string, number>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function parseLogLevel(v: string | undefined): LogLevel {
  return v !== undefined && v in ORDER ? (v as LogLevel) : "info";
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const min = ORDER[level];
  const log = (lvl: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void => {
    if (ORDER[lvl] < min) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }) + "\n");
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}
