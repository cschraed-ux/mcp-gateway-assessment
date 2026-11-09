/**
 * On-disk SQLite storage (better-sqlite3) for tenants, the rate limiter's usage events and a
 * request log.
 *
 * Why SQLite on disk rather than an in-memory Map: rate-limit state survives a restart (a tenant
 * cannot reset its budget by crashing the gateway), and several gateway processes on one host can
 * share the same file safely. WAL mode lets readers proceed while one writer commits;
 * `busy_timeout` makes a second process wait for the write lock instead of failing with
 * SQLITE_BUSY; `synchronous = NORMAL` is the recommended durability/speed trade-off for WAL.
 * Schema changes are applied through a tiny idempotent migrations table so opening the same file
 * twice (or from two processes) is harmless. API keys are stored only as SHA-256 hashes.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DB = Database.Database;

export const DEFAULT_DB_PATH = "./data/gateway.db";

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE tenants (
        api_key_hash      TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        tokens_per_minute INTEGER NOT NULL CHECK (tokens_per_minute > 0),
        created_at        INTEGER
      );
      CREATE TABLE token_usage (
        id         INTEGER PRIMARY KEY,
        tenant_id  TEXT NOT NULL,
        ts_ms      INTEGER NOT NULL,
        tokens     INTEGER NOT NULL CHECK (tokens >= 0),
        state      TEXT NOT NULL CHECK (state IN ('reserved','settled')),
        request_id TEXT NOT NULL UNIQUE
      );
      CREATE INDEX token_usage_tenant_ts ON token_usage (tenant_id, ts_ms);
      CREATE INDEX token_usage_ts ON token_usage (ts_ms);
      CREATE TABLE request_log (
        request_id        TEXT PRIMARY KEY,
        tenant_id         TEXT,
        model_requested   TEXT,
        provider_used     TEXT,
        status            INTEGER,
        latency_ms        INTEGER,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        error_type        TEXT,
        created_at        INTEGER
      );
    `,
  },
];

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["DB_PATH"] && env["DB_PATH"].length > 0 ? env["DB_PATH"] : DEFAULT_DB_PATH;
}

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  // IMMEDIATE: if two processes open a fresh file at once, only one runs each migration.
  const apply = db.transaction((m: { version: number; sql: string }) => {
    if (applied.get(m.version)) return;
    db.exec(m.sql);
    record.run(m.version, Date.now());
  });
  for (const m of MIGRATIONS) apply.immediate(m);
}

export interface TenantSeed {
  apiKey: string;
  tenantId: string;
  tokensPerMinute: number;
}

export interface Tenant {
  tenantId: string;
  tokensPerMinute: number;
}

/** Insert or update tenants. Only the hash of each key is stored. */
export function seedTenants(db: DB, tenants: readonly TenantSeed[], now: number = Date.now()): void {
  const upsert = db.prepare(`
    INSERT INTO tenants (api_key_hash, tenant_id, tokens_per_minute, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(api_key_hash) DO UPDATE SET
      tenant_id = excluded.tenant_id, tokens_per_minute = excluded.tokens_per_minute
  `);
  db.transaction(() => {
    for (const t of tenants) upsert.run(hashApiKey(t.apiKey), t.tenantId, t.tokensPerMinute, now);
  }).immediate();
}

/** Looks tenants up by key hash; the plaintext key never touches the database. */
export class TenantStore {
  private readonly byHash: Database.Statement<[string], { tenant_id: string; tokens_per_minute: number }>;

  constructor(db: DB) {
    this.byHash = db.prepare("SELECT tenant_id, tokens_per_minute FROM tenants WHERE api_key_hash = ?");
  }

  findByApiKey(apiKey: string): Tenant | undefined {
    const row = this.byHash.get(hashApiKey(apiKey));
    return row ? { tenantId: row.tenant_id, tokensPerMinute: row.tokens_per_minute } : undefined;
  }
}

export interface RequestLogEntry {
  requestId: string;
  tenantId: string | null;
  modelRequested: string | null;
  providerUsed: string | null;
  status: number;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  errorType: string | null;
  createdAt: number;
}

export class RequestLog {
  private readonly insert: Database.Statement<unknown[]>;

  constructor(db: DB) {
    this.insert = db.prepare(`
      INSERT OR REPLACE INTO request_log (request_id, tenant_id, model_requested, provider_used, status,
        latency_ms, prompt_tokens, completion_tokens, error_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  write(e: RequestLogEntry): void {
    this.insert.run(
      e.requestId, e.tenantId, e.modelRequested, e.providerUsed, e.status,
      e.latencyMs, e.promptTokens, e.completionTokens, e.errorType, e.createdAt,
    );
  }
}
