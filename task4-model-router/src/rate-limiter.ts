/**
 * Token-aware sliding-window rate limiter backed by SQLite.
 *
 * Model: every admitted request inserts one usage EVENT `(tenant, ts_ms, tokens)`. The tokens used
 * "in the last minute" at time `now` are `SUM(tokens) WHERE ts_ms > now - windowMs`, a true
 * sliding window over events (no fixed buckets, so no 2x burst at a bucket boundary). Admission is
 * reserve-then-settle: `tryReserve` inserts a `reserved` event for the estimated tokens, and after
 * the call `settle` rewrites it to the actual usage (lower or higher) or `release` deletes it.
 *
 * Atomicity: the check (SUM) and the insert run inside one `BEGIN IMMEDIATE` transaction.
 * better-sqlite3 is synchronous, so inside a single process no other JavaScript can run between
 * the check and the insert (the event loop cannot interleave a synchronous function); across
 * processes sharing the file, IMMEDIATE takes SQLite's write lock up front, so a second process
 * blocks (up to busy_timeout) instead of reading the same stale sum. Either way two concurrent
 * requests can never both spend the same remaining budget.
 *
 * `retryAfterMs` is exact for the current state: we walk the window's events oldest-first and
 * find the moment enough of them age out for the request to fit. Old rows are deleted by `evict`,
 * which runs opportunistically every `evictEvery` reservations and on a timer in the server; the
 * window query never depends on eviction for correctness, only for table size.
 * Cost: O(events in window) per check; see the README for how to scale this.
 */
import type Database from "better-sqlite3";
import type { DB } from "./db.js";

export interface RateLimiterOptions {
  windowMs?: number;
  clock?: () => number;
  /** Run evict() every N tryReserve calls (0 disables). */
  evictEvery?: number;
}

export type ReserveResult =
  | { allowed: true; remaining: number; usedInWindow: number; limit: number; resetMs: number }
  | { allowed: false; reason: "window_full"; retryAfterMs: number; usedInWindow: number; limit: number }
  | { allowed: false; reason: "request_exceeds_limit"; usedInWindow: number; limit: number };

export interface WindowStatus {
  usedInWindow: number;
  remaining: number;
  limit: number;
  /** ms until the whole limit is available again (newest event ages out); 0 if the window is empty. */
  resetMs: number;
}

interface EventRow {
  ts_ms: number;
  tokens: number;
}

export class SlidingWindowRateLimiter {
  readonly windowMs: number;
  private readonly clock: () => number;
  private readonly evictEvery: number;
  private calls = 0;

  private readonly sumStmt: Database.Statement<[string, number], { used: number; newest: number | null }>;
  private readonly eventsStmt: Database.Statement<[string, number], EventRow>;
  private readonly insertStmt: Database.Statement<[string, number, number, string]>;
  private readonly settleStmt: Database.Statement<[number, string]>;
  private readonly releaseStmt: Database.Statement<[string]>;
  private readonly evictStmt: Database.Statement<[number]>;
  private readonly reserveTx: (tenantId: string, limit: number, tokens: number, requestId: string, now: number) => ReserveResult;

  constructor(db: DB, opts: RateLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.clock = opts.clock ?? (() => Date.now());
    this.evictEvery = opts.evictEvery ?? 100;

    this.sumStmt = db.prepare(
      "SELECT COALESCE(SUM(tokens), 0) AS used, MAX(ts_ms) AS newest FROM token_usage WHERE tenant_id = ? AND ts_ms > ?",
    );
    this.eventsStmt = db.prepare(
      "SELECT ts_ms, tokens FROM token_usage WHERE tenant_id = ? AND ts_ms > ? ORDER BY ts_ms ASC, id ASC",
    );
    this.insertStmt = db.prepare(
      "INSERT INTO token_usage (tenant_id, ts_ms, tokens, state, request_id) VALUES (?, ?, ?, 'reserved', ?)",
    );
    // Only a still-reserved row can be settled: a second settle for the same request is a no-op,
    // so a late or duplicated completion can never double-count.
    this.settleStmt = db.prepare(
      "UPDATE token_usage SET tokens = ?, state = 'settled' WHERE request_id = ? AND state = 'reserved'",
    );
    this.releaseStmt = db.prepare("DELETE FROM token_usage WHERE request_id = ? AND state = 'reserved'");
    this.evictStmt = db.prepare("DELETE FROM token_usage WHERE ts_ms <= ?");

    const tx = db.transaction(
      (tenantId: string, limit: number, tokens: number, requestId: string, now: number): ReserveResult => {
        const since = now - this.windowMs;
        const { used } = this.sumStmt.get(tenantId, since) ?? { used: 0 };
        if (used + tokens <= limit) {
          this.insertStmt.run(tenantId, now, tokens, requestId);
          // The newest event is the one just inserted, so the full limit returns one window from now.
          return { allowed: true, remaining: limit - used - tokens, usedInWindow: used + tokens, limit, resetMs: this.windowMs };
        }
        return {
          allowed: false,
          reason: "window_full",
          retryAfterMs: this.exactRetryAfter(tenantId, since, now, used + tokens - limit),
          usedInWindow: used,
          limit,
        };
      },
    );
    this.reserveTx = (...args) => tx.immediate(...args);
  }

  /**
   * Atomically check the window and, if the request fits, record a reservation for it.
   * `estimatedTokens > limit` can never succeed, so it is rejected at once with its own reason
   * instead of a retry-after the caller would wait on forever.
   */
  tryReserve(tenantId: string, limit: number, estimatedTokens: number, requestId: string): ReserveResult {
    if (!Number.isInteger(estimatedTokens) || estimatedTokens < 0) {
      throw new RangeError("estimatedTokens must be a non-negative integer");
    }
    const now = this.clock();
    if (this.evictEvery > 0 && ++this.calls % this.evictEvery === 0) this.evict(now);
    if (estimatedTokens > limit) {
      const { used } = this.sumStmt.get(tenantId, now - this.windowMs) ?? { used: 0 };
      return { allowed: false, reason: "request_exceeds_limit", usedInWindow: used, limit };
    }
    return this.reserveTx(tenantId, limit, estimatedTokens, requestId, now);
  }

  /** Replace a reservation with the actual usage. Returns false if there was nothing to settle. */
  settle(requestId: string, actualTokens: number): boolean {
    const tokens = Math.max(0, Math.ceil(actualTokens));
    return this.settleStmt.run(tokens, requestId).changes === 1;
  }

  /** Drop a reservation for a call that consumed no tokens. Returns false if none was pending. */
  release(requestId: string): boolean {
    return this.releaseStmt.run(requestId).changes === 1;
  }

  /** Delete events that have left the window. Returns the number of rows removed. */
  evict(now: number = this.clock()): number {
    return this.evictStmt.run(now - this.windowMs).changes;
  }

  status(tenantId: string, limit: number): WindowStatus {
    const now = this.clock();
    const { used, newest } = this.sumStmt.get(tenantId, now - this.windowMs) ?? { used: 0, newest: null };
    return {
      usedInWindow: used,
      remaining: Math.max(0, limit - used),
      limit,
      resetMs: newest === null ? 0 : newest + this.windowMs - now,
    };
  }

  /**
   * An event at ts counts while ts > now - windowMs, i.e. it leaves the window at ts + windowMs.
   * Walk events oldest-first until the freed tokens cover the shortfall; that event's exit time
   * is the earliest moment the request fits (assuming no new usage arrives meanwhile).
   */
  private exactRetryAfter(tenantId: string, since: number, now: number, shortfall: number): number {
    let freed = 0;
    for (const e of this.eventsStmt.iterate(tenantId, since)) {
      freed += e.tokens;
      if (freed >= shortfall) return Math.max(1, e.ts_ms + this.windowMs - now);
    }
    // Unreachable when estimatedTokens <= limit; fall back to a full window to stay safe.
    return this.windowMs;
  }
}
