import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { openDatabase, seedTenants, TenantStore } from "../src/db.js";
import { GatewayError } from "../src/errors.js";
import { createMockProvider, type MockProvider } from "../src/mock-providers.js";
import { CompletionPipeline } from "../src/pipeline.js";
import {
  type CompletionRequest,
  type CompletionResult,
  HttpProvider,
  type ModelProvider,
  parseRetryAfter,
  UpstreamAborted,
  UpstreamBadResponse,
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamRateLimited,
  UpstreamTimeout,
} from "../src/providers.js";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";
import { failoverReason, ModelRouter, shouldFailover } from "../src/router.js";
import { tempDbPath } from "./helpers.js";

const REQ: CompletionRequest = { model: "gpt-test", prompt: "Say hi", maxTokens: 50 };

describe("shouldFailover policy", () => {
  it.each([
    ["429 rate limited", new UpstreamRateLimited("p", 1000), "rate_limited"],
    ["timeout", new UpstreamTimeout("p", 3000), "timeout"],
    ["500", new UpstreamHttpError("p", 500), "server_error"],
    ["502", new UpstreamHttpError("p", 502), "server_error"],
    ["503", new UpstreamHttpError("p", 503), "server_error"],
    ["408", new UpstreamHttpError("p", 408), "server_error"],
    ["401", new UpstreamHttpError("p", 401), "auth_error"],
    ["403", new UpstreamHttpError("p", 403), "auth_error"],
    ["network error", new UpstreamNetworkError("p"), "network_error"],
    ["bad response", new UpstreamBadResponse("p"), "bad_response"],
  ])("fails over on %s", (_label, err, reason) => {
    expect(shouldFailover(err)).toBe(true);
    expect(failoverReason(err)).toBe(reason);
  });

  it.each([
    ["400", new UpstreamHttpError("p", 400)],
    ["404", new UpstreamHttpError("p", 404)],
    ["413", new UpstreamHttpError("p", 413)],
    ["422", new UpstreamHttpError("p", 422)],
    ["our own abort", new UpstreamAborted("p")],
    ["a non-upstream bug", new TypeError("x is undefined")],
  ])("does not fail over on %s", (_label, err) => {
    expect(shouldFailover(err)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("ModelRouter with HTTP mock providers", () => {
  let primary: MockProvider;
  let secondary: MockProvider;
  let router: ModelRouter;

  beforeAll(async () => {
    primary = createMockProvider({ name: "primary" });
    secondary = createMockProvider({ name: "secondary" });
    await primary.listen();
    await secondary.listen();
  });
  afterAll(async () => {
    await primary.close();
    await secondary.close();
  });
  beforeEach(() => {
    primary.requests.length = 0;
    secondary.requests.length = 0;
    primary.setBehaviour({ kind: "ok", text: "from primary", completionTokens: 5 });
    secondary.setBehaviour({ kind: "ok", text: "from secondary", completionTokens: 7 });
    router = new ModelRouter({
      primary: new HttpProvider({ name: "primary", baseUrl: primary.url(), apiKey: "pk", model: "p-model" }),
      secondary: new HttpProvider({ name: "secondary", baseUrl: secondary.url(), apiKey: "sk", model: "s-model" }),
      timeoutMs: 200,
    });
  });

  it("uses the primary when it succeeds, without failover", async () => {
    const r = await router.route(REQ, "r1");
    expect(r).toMatchObject({ providerUsed: "primary", failedOver: false, result: { text: "from primary", model: "p-model" } });
    expect(r.result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(r.failoverReason).toBeUndefined();
    expect(secondary.requests).toHaveLength(0);
    // OpenAI-compatible request with the provider's own key and model.
    expect(primary.requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer pk",
      body: { model: "p-model", messages: [{ role: "user", content: "Say hi" }], max_tokens: 50 },
    });
  });

  it("fails over to the secondary when the primary returns 429", async () => {
    primary.setBehaviour({ kind: "rateLimit", retryAfterSec: 3 });
    const r = await router.route(REQ, "r2");
    expect(r).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "rate_limited" });
    expect(r.result.text).toBe("from secondary");
    expect(primary.requests).toHaveLength(1); // no retry storm against a rate-limited primary
    expect(secondary.requests).toHaveLength(1);
  });

  it("fails over after the timeout when the primary hangs, and aborts the primary's socket", async () => {
    primary.setBehaviour({ kind: "hang", ms: 10_000 });
    const aborted = once(primary.events, "aborted");
    const started = Date.now();
    const r = await router.route(REQ, "r3");
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(195);
    expect(elapsed).toBeLessThan(2_000);
    await aborted; // the mock saw the client cancel the request
    expect(primary.requests[0]?.aborted).toBe(true);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["timeout", "ok"]);
  });

  it("times out when headers arrive quickly but the body stalls (timeout covers the body read)", async () => {
    primary.setBehaviour({ kind: "slowBody", ms: 10_000 });
    const r = await router.route(REQ, "r4");
    expect(r).toMatchObject({ providerUsed: "secondary", failoverReason: "timeout" });
  });

  it("fails over on a primary 500", async () => {
    primary.setBehaviour({ kind: "serverError", status: 500 });
    const r = await router.route(REQ, "r5");
    expect(r).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "server_error" });
  });

  it("fails over on a malformed (non-JSON) primary response", async () => {
    primary.setBehaviour({ kind: "badJson" });
    const r = await router.route(REQ, "r6");
    expect(r).toMatchObject({ providerUsed: "secondary", failoverReason: "bad_response" });
  });

  it("logs only the length and content-type of a malformed body, never its text", async () => {
    primary.setBehaviour({ kind: "badJson" });
    secondary.setBehaviour({ kind: "badJson" });
    const err = (await router.route(REQ, "r6b").catch((e: unknown) => e)) as GatewayError;
    const internal = JSON.stringify(err.internal);
    expect(internal).toContain('"reason":"invalid JSON"');
    expect(internal).toContain('"contentType":"application/json"');
    expect(internal).toMatch(/"bytes":\d+/);
    expect(internal).not.toMatch(/upstream exploded|choices|<html>/);
  });

  it("fails over when the primary rejects the gateway's credential with 401", async () => {
    primary.setBehaviour({ kind: "clientError", status: 401 });
    const r = await router.route(REQ, "r7a");
    expect(r).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "auth_error" });
    expect(r.result.text).toBe("from secondary");
    expect(primary.requests).toHaveLength(1);
  });

  it("fails over when the primary refuses the gateway's entitlement with 403", async () => {
    primary.setBehaviour({ kind: "clientError", status: 403 });
    const r = await router.route(REQ, "r7b");
    expect(r).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "auth_error" });
  });

  it("returns upstream_unavailable (503, retryable) when both providers fail with 401/403", async () => {
    primary.setBehaviour({ kind: "clientError", status: 401 });
    secondary.setBehaviour({ kind: "clientError", status: 403 });
    const err = (await router.route(REQ, "r7c").catch((e: unknown) => e)) as GatewayError;
    expect(err).toMatchObject({ type: "upstream_unavailable", status: 503, retryable: true });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("does not fail over on a primary 404 and reports upstream_rejected", async () => {
    primary.setBehaviour({ kind: "clientError", status: 404 });
    const err = await router.route(REQ, "r7d").catch((e: unknown) => e);
    expect(err).toMatchObject({ type: "upstream_rejected", status: 502, retryable: false });
    expect(secondary.requests).toHaveLength(0);
  });

  it("does not fail over on a primary 400 and reports upstream_rejected (502, not retryable)", async () => {
    primary.setBehaviour({ kind: "clientError", status: 400 });
    const err = await router.route(REQ, "r7").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ type: "upstream_rejected", status: 502, retryable: false });
    expect(secondary.requests).toHaveLength(0);
  });

  it("returns upstream_unavailable (503, retryable) when both providers fail", async () => {
    primary.setBehaviour({ kind: "serverError", status: 503 });
    secondary.setBehaviour({ kind: "rateLimit", retryAfterSec: 2 });
    const err = (await router.route(REQ, "r8").catch((e: unknown) => e)) as GatewayError;
    expect(err).toMatchObject({ type: "upstream_unavailable", status: 503, retryable: true, code: "all_providers_failed" });
    expect(err.retryAfterMs).toBeUndefined(); // only one of the two gave a retry time
    // Both causes are kept for the log only.
    expect(JSON.stringify(err.internal)).toContain("UpstreamHttpError");
    expect(JSON.stringify(err.internal)).toContain("UpstreamRateLimited");
    expect(JSON.stringify(err.toPayload("r8"))).not.toContain("Upstream");
  });

  it("passes on a retry time when every provider was rate limited", async () => {
    primary.setBehaviour({ kind: "rateLimit", retryAfterSec: 9 });
    secondary.setBehaviour({ kind: "rateLimit", retryAfterSec: 4 });
    const err = (await router.route(REQ, "r9").catch((e: unknown) => e)) as GatewayError;
    expect(err).toMatchObject({ type: "upstream_unavailable", retryAfterMs: 4000 });
    expect(err.headers()["retry-after"]).toBe("4");
  });

  it("returns upstream_timeout (504) when both providers time out", async () => {
    primary.setBehaviour({ kind: "hang", ms: 10_000 });
    secondary.setBehaviour({ kind: "hang", ms: 10_000 });
    const err = await router.route(REQ, "r10").catch((e: unknown) => e);
    expect(err).toMatchObject({ type: "upstream_timeout", status: 504, retryable: true });
  });

  it("uses a 3000ms timeout by default", { timeout: 15_000 }, async () => {
    primary.setBehaviour({ kind: "hang", ms: 10_000 });
    const defaultRouter = new ModelRouter({
      primary: new HttpProvider({ name: "primary", baseUrl: primary.url(), apiKey: "pk" }),
      secondary: new HttpProvider({ name: "secondary", baseUrl: secondary.url(), apiKey: "sk" }),
    });
    expect(defaultRouter.timeoutMs).toBe(3000);
    const r = await defaultRouter.route(REQ, "r11");
    expect(r.providerUsed).toBe("secondary");
    const primaryAttempt = r.attempts[0];
    expect(primaryAttempt?.outcome).toBe("timeout");
    expect(primaryAttempt?.latencyMs).toBeGreaterThanOrEqual(2_990);
    expect(primaryAttempt?.latencyMs).toBeLessThan(3_500);
  });
});

describe("ModelRouter network failures", () => {
  it("fails over on ECONNREFUSED and gives upstream_unavailable when nothing is listening", async () => {
    const dead = createMockProvider({ name: "dead" });
    const deadUrl = await dead.listen();
    await dead.close(); // the port is now closed: connections are refused
    const live = createMockProvider({ name: "live" });
    await live.listen();
    try {
      const ok = await new ModelRouter({
        primary: new HttpProvider({ name: "primary", baseUrl: deadUrl, apiKey: "k" }),
        secondary: new HttpProvider({ name: "secondary", baseUrl: live.url(), apiKey: "k" }),
        timeoutMs: 500,
      }).route(REQ, "n1");
      expect(ok).toMatchObject({ providerUsed: "secondary", failoverReason: "network_error" });

      const err = (await new ModelRouter({
        primary: new HttpProvider({ name: "primary", baseUrl: deadUrl, apiKey: "k" }),
        secondary: new HttpProvider({ name: "secondary", baseUrl: deadUrl, apiKey: "k" }),
        timeoutMs: 500,
      })
        .route(REQ, "n2")
        .catch((e: unknown) => e)) as GatewayError;
      expect(err.type).toBe("upstream_unavailable");
      expect(JSON.stringify(err.internal)).toContain("ECONNREFUSED"); // detail kept for logs...
      expect(JSON.stringify(err.toPayload("n2"))).not.toContain("ECONNREFUSED"); // ...never returned
    } finally {
      await live.close();
    }
  });
});

/** In-process provider driven by (fake) timers. `respectAbort: false` models a stubborn upstream. */
function timedProvider(
  name: string,
  delayMs: number,
  outcome: CompletionResult | Error,
  opts: { respectAbort?: boolean } = {},
): ModelProvider & { calls: number; abortedSeen: number } {
  const p = {
    name,
    calls: 0,
    abortedSeen: 0,
    complete(_req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
      p.calls++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => (outcome instanceof Error ? reject(outcome) : resolve(outcome)), delayMs);
        signal.addEventListener("abort", () => {
          p.abortedSeen++;
          if (opts.respectAbort !== false) {
            clearTimeout(t);
            reject(new UpstreamAborted(name));
          }
        });
      });
    },
  };
  return p;
}

const result = (text: string, promptTokens: number, completionTokens: number): CompletionResult => ({
  text,
  model: `${text}-model`,
  usage: { promptTokens, completionTokens },
});

describe("timeout race conditions (fake timers)", () => {
  const tmp = tempDbPath("router-race");
  const db = openDatabase(tmp.dbPath);
  seedTenants(db, [{ apiKey: "race-key", tenantId: "race-tenant", tokensPerMinute: 100_000 }]);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(() => {
    db.close();
    tmp.cleanup();
  });

  it("ignores a primary that resolves at 3100ms after the 3000ms timeout; settles once with the secondary's usage", async () => {
    const primary = timedProvider("primary", 3_100, result("late-primary", 999, 999), { respectAbort: false });
    const secondary = timedProvider("secondary", 500, result("secondary", 11, 22)); // resolves at 3500ms
    const limiter = new SlidingWindowRateLimiter(db, { clock: () => Date.now() });
    const settle = vi.spyOn(limiter, "settle");
    const release = vi.spyOn(limiter, "release");
    const pipeline = new CompletionPipeline({
      tenants: new TenantStore(db),
      limiter,
      router: new ModelRouter({ primary, secondary, timeoutMs: 3_000 }),
    });

    let settled = false;
    const done = pipeline.complete("race-key", () => ({ model: "m", prompt: "hello", max_tokens: 100 }), "race-1").finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(primary.abortedSeen).toBe(1); // abort was signalled at the deadline
    expect(secondary.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100); // 3100ms: the stubborn primary resolves now...
    expect(settled).toBe(false); // ...and that changes nothing
    await vi.advanceTimersByTimeAsync(400); // 3500ms: secondary answers
    const out = await done;

    expect(out.route).toMatchObject({ providerUsed: "secondary", failedOver: true, failoverReason: "timeout" });
    expect(out.route.result.text).toBe("secondary");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("race-1", 33);
    expect(release).not.toHaveBeenCalled();
    expect(limiter.status("race-tenant", 100_000).usedInWindow).toBe(33);
    expect(vi.getTimerCount()).toBe(0); // no dangling timers
  });

  it("clears the timer when the primary wins, leaving no pending timers", async () => {
    const primary = timedProvider("primary", 100, result("p", 1, 1));
    const secondary = timedProvider("secondary", 100, result("s", 1, 1));
    const router = new ModelRouter({ primary, secondary, timeoutMs: 3_000 });
    const done = router.route(REQ, "t1");
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toMatchObject({ providerUsed: "primary" });
    expect(vi.getTimerCount()).toBe(0); // the 3000ms deadline was cleared, not left to fire
    expect(primary.abortedSeen).toBe(1); // the finished attempt's controller is closed too (harmless)
  });

  it("gives each attempt a fresh timeout and clears both when both time out", async () => {
    const primary = timedProvider("primary", 60_000, result("p", 1, 1));
    const secondary = timedProvider("secondary", 60_000, result("s", 1, 1));
    const router = new ModelRouter({ primary, secondary, timeoutMs: 3_000 });
    const done = router.route(REQ, "t2").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(secondary.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(secondary.calls).toBe(1); // failover at exactly 3000ms
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await done;
    expect(err).toMatchObject({ type: "upstream_timeout" });
    expect(primary.abortedSeen).toBe(1);
    expect(secondary.abortedSeen).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not produce an unhandled rejection when a timed-out primary later rejects", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const primary = timedProvider("primary", 3_200, new UpstreamHttpError("primary", 500), { respectAbort: false });
      const secondary = timedProvider("secondary", 10, result("s", 1, 1));
      const done = new ModelRouter({ primary, secondary, timeoutMs: 3_000 }).route(REQ, "t3");
      await vi.advanceTimersByTimeAsync(3_500);
      await expect(done).resolves.toMatchObject({ providerUsed: "secondary" });
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("still returns the completion when the database fails after the call (settle and status both throw)", async () => {
    const limiter = new SlidingWindowRateLimiter(db, { clock: () => Date.now() });
    const dbDown = (): never => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    };
    vi.spyOn(limiter, "settle").mockImplementation(dbDown);
    vi.spyOn(limiter, "status").mockImplementation(dbDown);
    const pipeline = new CompletionPipeline({
      tenants: new TenantStore(db),
      limiter,
      router: new ModelRouter({
        primary: timedProvider("primary", 10, result("p", 3, 4)),
        secondary: timedProvider("secondary", 10, result("s", 1, 1)),
        timeoutMs: 3_000,
      }),
    });
    const done = pipeline.complete("race-key", () => ({ model: "m", prompt: "hello", max_tokens: 10 }), "race-db-down");
    await vi.advanceTimersByTimeAsync(20);
    const out = await done;
    expect(out.route.result.text).toBe("p");
    // Rate-limit headers fall back to the admission-time view: 2 (prompt) + 10 (max_tokens) reserved.
    expect(out.rate.limit).toBe(100_000);
    expect(out.rate.usedInWindow).toBeGreaterThanOrEqual(12);
    expect(out.rate.remaining).toBe(100_000 - out.rate.usedInWindow);
  });

  it("releases the reservation (no tokens charged) when every provider fails", async () => {
    const limiter = new SlidingWindowRateLimiter(db, { clock: () => Date.now() });
    const settle = vi.spyOn(limiter, "settle");
    const pipeline = new CompletionPipeline({
      tenants: new TenantStore(db),
      limiter,
      router: new ModelRouter({
        primary: timedProvider("primary", 10, new UpstreamRateLimited("primary")),
        secondary: timedProvider("secondary", 10, new UpstreamHttpError("secondary", 502)),
        timeoutMs: 3_000,
      }),
    });
    const before = limiter.status("race-tenant", 100_000).usedInWindow;
    const done = pipeline.complete("race-key", () => ({ model: "m", prompt: "hello" }), "race-2").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await done).toMatchObject({ type: "upstream_unavailable" });
    expect(settle).not.toHaveBeenCalled();
    expect(limiter.status("race-tenant", 100_000).usedInWindow).toBe(before);
  });
});
