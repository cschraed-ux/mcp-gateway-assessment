/**
 * Environment configuration with safe defaults. Numbers are validated (a typo such as
 * MAX_HOLD_CHARS=abc falls back to the default and is reported, instead of becoming NaN and
 * silently disabling the hold-back). Secrets are read here and passed only to the adapter that
 * needs them; they are never logged.
 */
import { parseLogLevel, type LogLevel } from "./logger.js";

export type ProviderKind = "mock" | "openai" | "anthropic";

export interface Config {
  provider: ProviderKind;
  port: number;
  host: string;
  openaiBaseUrl: string;
  openaiApiKey: string | undefined;
  openaiModel: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicModel: string | undefined;
  anthropicVersion: string;
  /** Opt-in: true only when ANTHROPIC_FALLBACKS=default. */
  anthropicFallbacks: boolean;
  maxHoldChars: number;
  idleFlushMs: number;
  maxResponseBytes: number;
  firstByteGraceMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  logLevel: LogLevel;
  warnings: string[];
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, warnings: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    warnings.push(`${key}=${raw} is not an integer >= ${min}; using ${def}`);
    return def;
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const p = (env["PROVIDER"] ?? "mock").toLowerCase();
  let provider: ProviderKind = "mock";
  if (p === "openai" || p === "anthropic" || p === "mock") provider = p;
  else warnings.push(`PROVIDER=${p} is unknown; using mock`);
  return {
    provider,
    port: int(env, "PORT", 8082, 0, warnings),
    host: env["HOST"] ?? "127.0.0.1",
    openaiBaseUrl: env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
    openaiApiKey: env["OPENAI_API_KEY"],
    openaiModel: env["OPENAI_MODEL"],
    anthropicApiKey: env["ANTHROPIC_API_KEY"],
    anthropicModel: env["ANTHROPIC_MODEL"],
    anthropicVersion: env["ANTHROPIC_VERSION"] ?? "2023-06-01",
    anthropicFallbacks: env["ANTHROPIC_FALLBACKS"] === "default",
    maxHoldChars: int(env, "MAX_HOLD_CHARS", 320, 1, warnings),
    idleFlushMs: int(env, "IDLE_FLUSH_MS", 0, 0, warnings),
    maxResponseBytes: int(env, "MAX_RESPONSE_BYTES", 1 << 20, 1, warnings),
    firstByteGraceMs: int(env, "FIRST_BYTE_GRACE_MS", 1000, 0, warnings),
    requestTimeoutMs: int(env, "REQUEST_TIMEOUT_MS", 30_000, 0, warnings),
    headersTimeoutMs: int(env, "HEADERS_TIMEOUT_MS", 10_000, 0, warnings),
    logLevel: parseLogLevel(env["LOG_LEVEL"]),
    warnings,
  };
}
