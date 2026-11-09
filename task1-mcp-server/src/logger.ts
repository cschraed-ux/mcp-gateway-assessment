/**
 * Structured JSON-lines logger. Design choice: it writes to process.stderr and nowhere else,
 * because with the stdio transport stdout is reserved for JSON-RPC frames. Verbosity comes
 * from the LOG_LEVEL env var (debug | info | warn | error, default info). Callers must pass
 * already-redacted fields; see redactArgs for the tool-argument view.
 */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
};

/** Redacted view of tool args for logs: free-text `reason` is reduced to its length. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = k === "reason" ? { redacted: true, length: typeof v === "string" ? v.length : 0 } : v;
  }
  return out;
}
