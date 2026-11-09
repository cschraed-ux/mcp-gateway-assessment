/**
 * Configuration from environment variables, with defaults that make `npm run dev` work against
 * the local mock providers (`npm run dev:providers`). Validation is strict: a malformed number
 * is a startup error rather than a silently wrong timeout or port.
 */
import { resolveDbPath } from "./db.js";
import { type LogLevel, parseLogLevel } from "./logger.js";

export interface ProviderConfig {
  name: string;
  url: string;
  key: string;
  model: string;
}

export interface Config {
  port: number;
  /** Interface to bind; loopback by default so the seeded demo keys are not exposed to the network. */
  host: string;
  dbPath: string;
  primary: ProviderConfig;
  secondary: ProviderConfig;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  evictIntervalMs: number;
  logLevel: LogLevel;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    port: int(env, "PORT", 8084, 0, 65535),
    host: env["HOST"] && env["HOST"].length > 0 ? env["HOST"] : "127.0.0.1",
    dbPath: resolveDbPath(env),
    primary: {
      name: "primary",
      url: env["PRIMARY_URL"] ?? "http://127.0.0.1:8091/v1",
      key: env["PRIMARY_KEY"] ?? "mock-primary-key",
      model: env["PRIMARY_MODEL"] ?? "primary-model",
    },
    secondary: {
      name: "secondary",
      url: env["SECONDARY_URL"] ?? "http://127.0.0.1:8092/v1",
      key: env["SECONDARY_KEY"] ?? "mock-secondary-key",
      model: env["SECONDARY_MODEL"] ?? "secondary-model",
    },
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 3000, 1, 600_000),
    requestTimeoutMs: int(env, "REQUEST_TIMEOUT_MS", 30_000, 1000, 600_000),
    headersTimeoutMs: int(env, "HEADERS_TIMEOUT_MS", 10_000, 1000, 600_000),
    evictIntervalMs: int(env, "EVICT_INTERVAL_MS", 30_000, 1000, 3_600_000),
    logLevel: parseLogLevel(env["LOG_LEVEL"]),
  };
  if (config.headersTimeoutMs > config.requestTimeoutMs) {
    throw new Error("HEADERS_TIMEOUT_MS must not exceed REQUEST_TIMEOUT_MS");
  }
  return config;
}
