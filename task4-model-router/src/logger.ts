/**
 * Structured logger: one JSON object per line on stderr (stdout stays clean for tools).
 *
 * This is the ONLY place internal error detail (stack traces, upstream bodies, SQLite messages)
 * is allowed to go. Callers attach those under `err`; the logger serialises the error's name,
 * message, stack and any `.internal` field. As defence in depth, fields whose names look like
 * secrets or user content (api keys, authorization headers, prompts) are replaced with
 * "[redacted]" even if a caller passes them by mistake. The sink is injectable so tests can
 * capture lines or silence output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT = /^(api_?key|authorization|auth|token|secret|password|prompt|text|body_text)$/i;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  clock?: () => number;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? "info").toLowerCase();
  return v in ORDER ? (v as LogLevel) : "info";
}

export function serializeError(err: unknown, depth = 0): unknown {
  if (err instanceof Error && depth < 5) {
    const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack };
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) out["code"] = code;
    const internal = (err as { internal?: unknown }).internal;
    if (internal !== undefined) out["internal"] = serializeError(internal, depth + 1);
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out["cause"] = serializeError(cause, depth + 1);
    return out;
  }
  return err;
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT.test(k)) out[k] = "[redacted]";
    else if (v instanceof Error) out[k] = serializeError(v);
    else out[k] = v;
  }
  return out;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const sink = opts.sink ?? ((line: string) => void process.stderr.write(line + "\n"));
  const clock = opts.clock ?? (() => Date.now());
  const emit = (level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < min) return;
    const record = { ts: new Date(clock()).toISOString(), level, msg, ...(fields ? redact(fields) : {}) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg, note: "unserialisable log fields" });
    }
    sink(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** A logger that drops everything; handy default for library code and tests. */
export const silentLogger: Logger = createLogger({ level: "silent" });
