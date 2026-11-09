/**
 * Environment configuration for the gateway, validated once at startup.
 *
 * Every value has a safe default except the credential source: the gateway refuses to start
 * without either `JWT_SECRET` or `STATIC_TOKENS`, because a gateway that cannot authenticate
 * anybody would either reject everything or (worse) be tempted to trust a header. Invalid
 * numbers, URLs and token tables throw a `ConfigError` with a message that names the variable,
 * so misconfiguration fails loudly instead of degrading security silently. Secrets are never
 * echoed in error messages.
 */
import { parseStaticTokens, type StaticTokenTable } from "./auth.js";
import { isLogLevel, type LogLevel } from "./logger.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface GatewayConfig {
  port: number;
  host: string;
  path: string;
  downstreamUrl: string;
  jwtSecret?: string;
  staticTokens?: StaticTokenTable;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  maxBodyBytes: number;
  downstreamAuthHeader?: string;
  corsAllowedOrigins: string[];
  logLevel: LogLevel;
}

export const MIN_JWT_SECRET_LENGTH = 16;

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const downstreamUrl = nonEmpty(env, "DOWNSTREAM_URL") ?? "http://127.0.0.1:8081/mcp";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(downstreamUrl);
  } catch {
    throw new ConfigError("DOWNSTREAM_URL must be an absolute http(s) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigError("DOWNSTREAM_URL must be an absolute http(s) URL");
  }

  const jwtSecret = nonEmpty(env, "JWT_SECRET");
  if (jwtSecret !== undefined && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  const staticSpec = nonEmpty(env, "STATIC_TOKENS");
  let staticTokens: StaticTokenTable | undefined;
  if (staticSpec !== undefined) {
    try {
      staticTokens = parseStaticTokens(staticSpec);
    } catch (err) {
      throw new ConfigError(err instanceof Error ? err.message : "STATIC_TOKENS is invalid");
    }
  }
  if (jwtSecret === undefined && (staticTokens === undefined || staticTokens.size === 0)) {
    throw new ConfigError("set JWT_SECRET (HS256 signing secret) or STATIC_TOKENS (token:role,...)");
  }

  const logLevel = nonEmpty(env, "LOG_LEVEL") ?? "info";
  if (!isLogLevel(logLevel)) throw new ConfigError("LOG_LEVEL must be debug, info, warn or error");

  const path = nonEmpty(env, "GATEWAY_PATH") ?? "/mcp";
  if (!path.startsWith("/")) throw new ConfigError("GATEWAY_PATH must start with /");

  const config: GatewayConfig = {
    port: intVar(env, "PORT", 8080, 0, 65535),
    host: nonEmpty(env, "HOST") ?? "127.0.0.1",
    path,
    downstreamUrl,
    upstreamTimeoutMs: intVar(env, "UPSTREAM_TIMEOUT_MS", 10_000, 1, 600_000),
    requestTimeoutMs: intVar(env, "REQUEST_TIMEOUT_MS", 30_000, 1000, 600_000),
    headersTimeoutMs: intVar(env, "HEADERS_TIMEOUT_MS", 10_000, 1000, 600_000),
    maxBodyBytes: intVar(env, "MAX_BODY_BYTES", 1024 * 1024, 1, 100 * 1024 * 1024),
    corsAllowedOrigins: (nonEmpty(env, "CORS_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    logLevel,
  };
  if (config.headersTimeoutMs > config.requestTimeoutMs) {
    throw new ConfigError("HEADERS_TIMEOUT_MS must not exceed REQUEST_TIMEOUT_MS");
  }
  if (jwtSecret !== undefined) config.jwtSecret = jwtSecret;
  if (staticTokens !== undefined) config.staticTokens = staticTokens;
  const downstreamAuthHeader = nonEmpty(env, "DOWNSTREAM_AUTH_HEADER");
  if (downstreamAuthHeader !== undefined) config.downstreamAuthHeader = downstreamAuthHeader;
  return config;
}
