/**
 * Entry point: `tsx src/index.ts` runs the gateway; `tsx src/index.ts --mint-token <role>`
 * prints a signed demo JWT and exits.
 *
 * Configuration comes from environment variables (see `config.ts` and the README). The token
 * minting mode is a CLI utility, so it is the one place that writes to stdout; the server
 * itself only logs JSON lines to stderr. Shutdown on SIGINT/SIGTERM stops accepting new
 * connections, closes idle ones and exits once in-flight requests finish (or after 5 seconds).
 */
import { createAuthenticator, isRole, ROLES, signToken, type AuthOptions } from "./auth.js";
import { ConfigError, loadConfig, MIN_JWT_SECRET_LENGTH } from "./config.js";
import { createGateway, type GatewayOptions } from "./gateway.js";
import { createLogger } from "./logger.js";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function mintToken(args: string[]): number {
  const role = argValue(args, "--mint-token");
  const secret = process.env.JWT_SECRET;
  if (!isRole(role)) {
    process.stderr.write(`usage: tsx src/index.ts --mint-token <${ROLES.join("|")}> [--sub name] [--ttl seconds]\n`);
    return 2;
  }
  if (secret === undefined || secret.length < MIN_JWT_SECRET_LENGTH) {
    process.stderr.write(`JWT_SECRET must be set (at least ${MIN_JWT_SECRET_LENGTH} characters) to mint a token\n`);
    return 2;
  }
  const ttl = Number(argValue(args, "--ttl") ?? 3600);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    process.stderr.write("--ttl must be a positive integer number of seconds\n");
    return 2;
  }
  const sub = argValue(args, "--sub");
  const token = signToken({ role, ttlSec: ttl, ...(sub !== undefined ? { sub } : {}) }, secret);
  process.stdout.write(token + "\n");
  return 0;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--mint-token")) {
    process.exitCode = mintToken(args);
    return;
  }

  const bootLogger = createLogger({ base: { service: "mcp-gateway" } });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    bootLogger.error("invalid configuration", { error: err instanceof ConfigError ? err.message : String(err) });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel, base: { service: "mcp-gateway" } });
  const authOptions: AuthOptions = {};
  if (config.jwtSecret !== undefined) authOptions.jwtSecret = config.jwtSecret;
  if (config.staticTokens !== undefined) authOptions.staticTokens = config.staticTokens;

  const gatewayOptions: GatewayOptions = {
    downstreamUrl: config.downstreamUrl,
    authenticate: createAuthenticator(authOptions),
    path: config.path,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    headersTimeoutMs: config.headersTimeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    corsAllowedOrigins: config.corsAllowedOrigins,
    logger,
  };
  if (config.downstreamAuthHeader !== undefined) gatewayOptions.downstreamAuthHeader = config.downstreamAuthHeader;

  const server = createGateway(gatewayOptions);
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : config.port;
    logger.info("gateway listening", {
      url: `http://${config.host}:${port}${config.path}`,
      downstreamUrl: config.downstreamUrl,
      auth: { jwt: config.jwtSecret !== undefined, staticTokens: config.staticTokens?.size ?? 0 },
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
