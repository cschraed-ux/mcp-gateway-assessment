import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { type DB, openDatabase } from "../src/db.js";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";
import { estimateTokens, reservationFor } from "../src/tokens.js";
import { manualClock, tempDbPath } from "./helpers.js";

const tmp = tempDbPath("limiter");
const open: DB[] = [];
const openDb = (path = tmp.dbPath): DB => {
  const db = openDatabase(path);
  open.push(db);
  return db;
};
const db = openDb();
const sumFor = (tenant: string, conn: DB = db): number =>
  (conn.prepare("SELECT COALESCE(SUM(tokens),0) AS s FROM token_usage WHERE tenant_id = ?").get(tenant) as { s: number }).s;

afterAll(() => {
  for (const d of open) if (d.open) d.close();
  tmp.cleanup();
});

let n = 0;
const tenant = (): string => `tenant-${++n}`;
const id = (): string => `req-${++n}`;

describe("token estimation", () => {
  it("estimates ceil(chars/4) and reserves prompt estimate plus max_tokens (default 256)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
    expect(reservationFor("x".repeat(40), 100)).toBe(110);
    expect(reservationFor("x".repeat(40))).toBe(266);
  });
});

describe("SlidingWindowRateLimiter", () => {
  let clock: ReturnType<typeof manualClock>;
  let limiter: SlidingWindowRateLimiter;
  beforeEach(() => {
    clock = manualClock();
    limiter = new SlidingWindowRateLimiter(db, { clock: clock.now, evictEvery: 0 });
  });

  it("admits up to the limit and then denies", () => {
    const t = tenant();
    for (let i = 0; i < 5; i++) {
      const r = limiter.tryReserve(t, 50_000, 10_000, id());
      expect(r).toMatchObject({ allowed: true, remaining: 50_000 - (i + 1) * 10_000 });
    }
    const denied = limiter.tryReserve(t, 50_000, 1, id());
    expect(denied).toMatchObject({ allowed: false, reason: "window_full", usedInWindow: 50_000, limit: 50_000 });
  });

  it("slides: an event ages out exactly windowMs after it was recorded", () => {
    const t = tenant();
    expect(limiter.tryReserve(t, 1000, 600, id()).allowed).toBe(true); // at T
    clock.advance(30_000);
    expect(limiter.tryReserve(t, 1000, 400, id()).allowed).toBe(true); // at T+30s, window full
    expect(limiter.tryReserve(t, 1000, 1, id()).allowed).toBe(false);
    clock.advance(29_999); // T+59.999s: first event still inside
    expect(limiter.tryReserve(t, 1000, 1, id()).allowed).toBe(false);
    clock.advance(1); // T+60s: first event has left the window
    expect(limiter.status(t, 1000).usedInWindow).toBe(400);
    clock.advance(1_000); // T+61s: the 30s event is still counted
    const r = limiter.tryReserve(t, 1000, 600, id());
    expect(r).toMatchObject({ allowed: true, usedInWindow: 1000, remaining: 0 });
  });

  it("computes retryAfterMs exactly from the oldest events in the window", () => {
    const t = tenant();
    limiter.tryReserve(t, 1000, 300, id()); // T
    clock.advance(10_000);
    limiter.tryReserve(t, 1000, 300, id()); // T+10s
    clock.advance(10_000);
    limiter.tryReserve(t, 1000, 300, id()); // T+20s, used 900
    clock.advance(5_000); // now T+25s
    // Needs 500: must free 400 -> first two events (600) -> second leaves at T+70s -> 45s from now.
    const r = limiter.tryReserve(t, 1000, 500, id());
    expect(r).toMatchObject({ allowed: false, reason: "window_full", retryAfterMs: 45_000, usedInWindow: 900 });
    // Needs 200: must free 100 -> first event leaves at T+60s -> 35s from now.
    expect(limiter.tryReserve(t, 1000, 200, id())).toMatchObject({ retryAfterMs: 35_000 });
    clock.advance(35_000);
    expect(limiter.tryReserve(t, 1000, 200, id()).allowed).toBe(true);
  });

  it("settle adjusts the window to actual usage, lower or higher than reserved", () => {
    const t = tenant();
    const a = id();
    const b = id();
    limiter.tryReserve(t, 10_000, 5_000, a);
    limiter.tryReserve(t, 10_000, 1_000, b);
    expect(limiter.settle(a, 1_200)).toBe(true); // lower
    expect(limiter.settle(b, 3_000)).toBe(true); // higher
    expect(limiter.status(t, 10_000)).toMatchObject({ usedInWindow: 4_200, remaining: 5_800 });
    expect(db.prepare("SELECT state FROM token_usage WHERE request_id = ?").get(a)).toEqual({ state: "settled" });
  });

  it("settles at most once per request, so a duplicate settle cannot double-count", () => {
    const t = tenant();
    const a = id();
    limiter.tryReserve(t, 10_000, 500, a);
    expect(limiter.settle(a, 100)).toBe(true);
    expect(limiter.settle(a, 9_000)).toBe(false);
    expect(limiter.release(a)).toBe(false); // a settled row is not released either
    expect(limiter.status(t, 10_000).usedInWindow).toBe(100);
  });

  it("release removes a reservation", () => {
    const t = tenant();
    const a = id();
    limiter.tryReserve(t, 1_000, 1_000, a);
    expect(limiter.tryReserve(t, 1_000, 1, id()).allowed).toBe(false);
    expect(limiter.release(a)).toBe(true);
    expect(limiter.status(t, 1_000).usedInWindow).toBe(0);
    expect(limiter.tryReserve(t, 1_000, 1_000, id()).allowed).toBe(true);
  });

  it("evict removes only rows that have left the window", () => {
    const t = tenant();
    limiter.tryReserve(t, 10_000, 100, id()); // T
    clock.advance(30_000);
    limiter.tryReserve(t, 10_000, 200, id()); // T+30s
    clock.advance(30_000); // T+60s: first is out
    const before = sumFor(t);
    expect(before).toBe(300);
    expect(limiter.evict()).toBeGreaterThanOrEqual(1);
    expect(sumFor(t)).toBe(200);
    expect(limiter.status(t, 10_000).usedInWindow).toBe(200);
  });

  it("runs eviction opportunistically every N reservations", () => {
    const l = new SlidingWindowRateLimiter(db, { clock: clock.now, evictEvery: 3 });
    const t = tenant();
    l.tryReserve(t, 10_000, 1, id());
    clock.advance(61_000);
    l.tryReserve(t, 10_000, 1, id());
    expect(sumFor(t)).toBe(2);
    l.tryReserve(t, 10_000, 1, id()); // 3rd call triggers evict before reserving
    expect(sumFor(t)).toBe(2);
  });

  it("rejects estimatedTokens > limit immediately with a distinct reason", () => {
    const t = tenant();
    const r = limiter.tryReserve(t, 1_000, 1_001, id());
    expect(r).toEqual({ allowed: false, reason: "request_exceeds_limit", usedInWindow: 0, limit: 1_000 });
    expect(sumFor(t)).toBe(0);
  });

  it("admits exactly 50 of 100 synchronous reservations of 1,000 against 50,000", () => {
    const t = tenant();
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (limiter.tryReserve(t, 50_000, 1_000, id()).allowed) allowed++;
    expect(allowed).toBe(50);
    expect(sumFor(t)).toBe(50_000);
  });

  it("admits exactly 50 of 100 concurrent async reservations (Promise.all)", async () => {
    const t = tenant();
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i % 7)); // interleave arrival order
        return limiter.tryReserve(t, 50_000, 1_000, id()).allowed;
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(50);
    expect(sumFor(t)).toBe(50_000);
  });

  it("persists window state across closing and reopening the database file", () => {
    const p = tempDbPath("persist");
    const t = tenant();
    const first = openDatabase(p.dbPath);
    new SlidingWindowRateLimiter(first, { clock: clock.now }).tryReserve(t, 1_000, 900, id());
    first.close(); // simulates a gateway restart
    const second = openDb(p.dbPath);
    const reopened = new SlidingWindowRateLimiter(second, { clock: clock.now });
    expect(reopened.tryReserve(t, 1_000, 200, id())).toMatchObject({ allowed: false, usedInWindow: 900 });
    second.close();
    p.cleanup();
  });

  it("never over-admits with two limiter instances on two connections to the same file", () => {
    const t = tenant();
    const other = openDb();
    const a = new SlidingWindowRateLimiter(db, { clock: clock.now });
    const b = new SlidingWindowRateLimiter(other, { clock: clock.now });
    let allowed = 0;
    for (let i = 0; i < 100; i++) if ((i % 2 ? a : b).tryReserve(t, 50_000, 1_000, id()).allowed) allowed++;
    expect(allowed).toBe(50);
    expect(sumFor(t, other)).toBe(50_000);
  });

  it("never over-admits with 4 worker threads racing on separate connections (multi-process safety)", async () => {
    const p = tempDbPath("workers");
    openDatabase(p.dbPath).close(); // run migrations once up front
    const start = new Int32Array(new SharedArrayBuffer(4));
    const workers = Array.from(
      { length: 4 },
      (_, workerId) =>
        new Worker(new URL("./fixtures/reserve-worker.ts", import.meta.url), {
          execArgv: ["--import", "tsx"],
          workerData: { dbPath: p.dbPath, workerId, attempts: 50, tokens: 1_000, limit: 50_000, start },
        }),
    );
    const ready: Promise<void>[] = [];
    const counts = workers.map(
      (w) =>
        new Promise<number>((resolve, reject) => {
          ready.push(new Promise<void>((r) => w.once("message", () => r())));
          w.on("message", (m: unknown) => {
            if (typeof m === "number") resolve(m);
          });
          w.once("error", reject);
        }),
    );
    await Promise.all(ready); // every worker has its connection open and is parked on Atomics.wait
    Atomics.store(start, 0, 1);
    Atomics.notify(start, 0);
    const allowed = (await Promise.all(counts)).reduce((a, b) => a + b, 0);
    expect(allowed).toBe(50);
    const check = openDatabase(p.dbPath);
    expect(sumFor("shared-tenant", check)).toBe(50_000);
    check.close();
    p.cleanup();
  });
});
