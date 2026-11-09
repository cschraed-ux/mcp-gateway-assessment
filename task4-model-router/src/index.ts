/**
 * Entry point: wires config -> SQLite -> rate limiter -> providers -> router -> pipeline -> HTTP.
 *
 * `--seed` inserts the demo tenants (see README) and exits. Otherwise the gateway listens on PORT
 * and runs `evict()` on an unref'd interval so the timer never keeps the process alive on its own.
 * SIGINT/SIGTERM stop accepting connections, then close the database cleanly (WAL checkpoint).
 */
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.js";
import { openDatabase, RequestLog, seedTenants, TenantStore } from "./db.js";
import { createLogger } from "./logger.js";
import { CompletionPipeline } from "./pipeline.js";
import { HttpProvider } from "./providers.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { ModelRouter } from "./router.js";
import { createGatewayServer } from "./server.js";

/** Demo tenants for local runs. Real deployments provision tenants out of band. */
export const DEMO_TENANTS = [
  { apiKey: "demo-key-123", tenantId: "tenant-demo", tokensPerMinute: 50_000 },
  { apiKey: "small-key-456", tenantId: "tenant-small", tokensPerMinute: 1_000 },
] as const;

function main(): void {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const db = openDatabase(config.dbPath);

  if (process.argv.includes("--seed")) {
    seedTenants(db, DEMO_TENANTS);
    logger.info("seeded demo tenants", { db_path: config.dbPath, tenants: DEMO_TENANTS.map((t) => t.tenantId) });
    db.close();
    return;
  }

  const limiter = new SlidingWindowRateLimiter(db);
  const provider = (p: typeof config.primary): HttpProvider =>
    new HttpProvider({ name: p.name, baseUrl: p.url, apiKey: p.key, model: p.model });
  const router = new ModelRouter({
    primary: provider(config.primary),
    secondary: provider(config.secondary),
    timeoutMs: config.upstreamTimeoutMs,
    logger,
  });
  const pipeline = new CompletionPipeline({
    tenants: new TenantStore(db),
    limiter,
    router,
    requestLog: new RequestLog(db),
    logger,
  });
  const server = createGatewayServer({
    pipeline,
    db,
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
    headersTimeoutMs: config.headersTimeoutMs,
  });

  const evictTimer = setInterval(() => {
    try {
      const removed = limiter.evict();
      if (removed > 0) logger.debug("evicted usage events", { removed });
    } catch (err) {
      logger.error("evict failed", { err });
    }
  }, config.evictIntervalMs);
  evictTimer.unref();

  server.listen(config.port, config.host, () => {
    const { port } = server.address() as AddressInfo;
    logger.info("gateway listening", {
      host: config.host,
      port,
      db_path: config.dbPath,
      primary: config.primary.url,
      secondary: config.secondary.url,
      upstream_timeout_ms: config.upstreamTimeoutMs,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    clearInterval(evictTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
