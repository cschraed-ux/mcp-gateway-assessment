import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { type DB, openDatabase, RequestLog, seedTenants, TenantStore } from "../src/db.js";
import { ERROR_TYPES } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { createMockProvider, type MockBehaviour, type MockProvider } from "../src/mock-providers.js";
import { CompletionPipeline } from "../src/pipeline.js";
import { HttpProvider } from "../src/providers.js";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";
import { ModelRouter } from "../src/router.js";
import { createGatewayServer } from "../src/server.js";
import { FORBIDDEN, tempDbPath } from "./helpers.js";

const PROMPT = "Tell me a short story about a very secretive lighthouse keeper.";
const KEYS = { main: "key-main-AAAA", small: "key-small-BBBB", conc: "key-conc-CCCC", tiny: "key-tiny-DDDD" };

interface Gateway {
  url: string;
  server: Server;
  db: DB;
  pipeline: CompletionPipeline;
  close: () => Promise<void>;
}

const logs: string[] = [];
const logger = createLogger({ level: "debug", sink: (l) => logs.push(l) });
const tmp = tempDbPath("server");
const gateways: Gateway[] = [];

async function startGateway(primaryUrl: string, secondaryUrl: string, dbPath = tmp.dbPath): Promise<Gateway> {
  const db = openDatabase(dbPath);
  seedTenants(db, [
    { apiKey: KEYS.main, tenantId: "t-main", tokensPerMinute: 1_000_000 },
    { apiKey: KEYS.small, tenantId: "t-small", tokensPerMinute: 1_000 },
    { apiKey: KEYS.conc, tenantId: "t-conc", tokensPerMinute: 1_000 },
    { apiKey: KEYS.tiny, tenantId: "t-tiny", tokensPerMinute: 100 },
  ]);
  const router = new ModelRouter({
    primary: new HttpProvider({ name: "primary", baseUrl: primaryUrl, apiKey: "upstream-primary-secret" }),
    secondary: new HttpProvider({ name: "secondary", baseUrl: secondaryUrl, apiKey: "upstream-secondary-secret" }),
    timeoutMs: 200,
    logger,
  });
  const pipeline = new CompletionPipeline({
    tenants: new TenantStore(db),
    limiter: new SlidingWindowRateLimiter(db),
    router,
    requestLog: new RequestLog(db),
    logger,
  });
  const server = createGatewayServer({ pipeline, db, logger, maxBodyBytes: 64 * 1024 });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const gw: Gateway = {
    url: `http://127.0.0.1:${port}`,
    server,
    db,
    pipeline,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      if (db.open) db.close();
    },
  };
  gateways.push(gw);
  return gw;
}

async function post(gw: Gateway, body: unknown, key: string | null = KEYS.main, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  const res = await fetch(`${gw.url}/v1/completions`, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  return { res, text, json: JSON.parse(text) as Record<string, any> };
}

/** Every error body must be exactly the standard payload and contain nothing internal. */
function expectStandardError(r: { res: Response; text: string; json: Record<string, any> }, type: keyof typeof ERROR_TYPES) {
  expect(r.res.status).toBe(ERROR_TYPES[type].status);
  expect(Object.keys(r.json)).toEqual(["error"]);
  const e = r.json["error"];
  expect(e.type).toBe(type);
  expect(typeof e.code).toBe("string");
  expect(e.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(typeof e.message).toBe("string");
  expect(typeof e.retryable).toBe("boolean");
  expect(e.request_id).toBe(r.res.headers.get("x-request-id"));
  for (const k of Object.keys(e)) expect(["code", "type", "message", "request_id", "retryable", "retry_after_ms"]).toContain(k);
  expect(r.text).not.toMatch(FORBIDDEN);
  expect(r.text).not.toMatch(/stack|Upstream\w+Error|upstream exploded|10\.0\.0\.7|secret/i);
}

let primary: MockProvider;
let secondary: MockProvider;
let gw: Gateway;

beforeAll(async () => {
  primary = createMockProvider({ name: "primary" });
  secondary = createMockProvider({ name: "secondary" });
  await primary.listen();
  await secondary.listen();
  gw = await startGateway(primary.url(), secondary.url());
});

afterAll(async () => {
  for (const g of gateways) await g.close();
  await primary.close();
  await secondary.close();
  tmp.cleanup();
});

beforeEach(() => {
  primary.setBehaviour({ kind: "ok", text: "primary says hi", completionTokens: 20 });
  secondary.setBehaviour({ kind: "ok", text: "secondary says hi", completionTokens: 30 });
  primary.requests.length = 0;
  secondary.requests.length = 0;
});

describe("POST /v1/completions", () => {
  it("returns the completion with rate-limit headers on the happy path", async () => {
    const r = await post(gw, { model: "gpt-x", prompt: PROMPT, max_tokens: 64 });
    expect(r.res.status).toBe(200);
    expect(r.json).toMatchObject({
      model: "gpt-x",
      provider: "primary",
      text: "primary says hi",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      failed_over: false,
    });
    expect(r.json["id"]).toBe(r.res.headers.get("x-request-id"));
    expect(r.res.headers.get("x-ratelimit-limit")).toBe("1000000");
    expect(Number(r.res.headers.get("x-ratelimit-remaining"))).toBeLessThanOrEqual(1_000_000 - 30);
    expect(Number(r.res.headers.get("x-ratelimit-reset-ms"))).toBeGreaterThan(0);
    const row = gw.db.prepare("SELECT * FROM request_log WHERE request_id = ?").get(r.json["id"]);
    expect(row).toMatchObject({ tenant_id: "t-main", provider_used: "primary", status: 200, prompt_tokens: 10, completion_tokens: 20 });
    const usage = gw.db.prepare("SELECT tokens, state FROM token_usage WHERE request_id = ?").get(r.json["id"]);
    expect(usage).toEqual({ tokens: 30, state: "settled" }); // reservation settled to actual usage
  });

  it("shows failover in the response when the primary is rate limited", async () => {
    primary.setBehaviour({ kind: "rateLimit", retryAfterSec: 5 });
    const r = await post(gw, { model: "gpt-x", prompt: PROMPT });
    expect(r.res.status).toBe(200);
    expect(r.json).toMatchObject({ provider: "secondary", text: "secondary says hi", failed_over: true });
    expect(primary.requests).toHaveLength(1);
    const usage = gw.db.prepare("SELECT tokens, state FROM token_usage WHERE request_id = ?").get(r.json["id"]);
    expect(usage).toEqual({ tokens: 40, state: "settled" }); // secondary's usage, settled once
  });

  it("answers 429 with Retry-After once the tenant's token budget is spent", async () => {
    primary.setBehaviour({ kind: "ok", promptTokens: 5, completionTokens: 895 });
    const first = await post(gw, { model: "m", prompt: "hi", max_tokens: 900 }, KEYS.small);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("x-ratelimit-remaining")).toBe("100");
    const second = await post(gw, { model: "m", prompt: "hi", max_tokens: 200 }, KEYS.small);
    expectStandardError(second, "rate_limited");
    expect(second.json["error"]).toMatchObject({ code: "token_rate_limit_exceeded", retryable: true });
    const retryMs = second.json["error"].retry_after_ms as number;
    expect(retryMs).toBeGreaterThan(55_000);
    expect(retryMs).toBeLessThanOrEqual(60_000);
    expect(second.res.headers.get("retry-after")).toBe(String(Math.ceil(retryMs / 1000)));
    expect(second.res.headers.get("x-ratelimit-limit")).toBe("1000");
    expect(second.res.headers.get("x-ratelimit-remaining")).toBe("100");
    expect(primary.requests).toHaveLength(1); // the rejected request never reached a provider
  });

  it("answers 413 when a single request needs more than the whole per-minute budget", async () => {
    const r = await post(gw, { model: "m", prompt: "hi", max_tokens: 500 }, KEYS.tiny);
    expectStandardError(r, "request_too_large");
    expect(r.json["error"].code).toBe("request_exceeds_token_limit");
    expect(r.res.headers.get("retry-after")).toBeNull(); // waiting would never help
  });

  it("rejects a missing or unknown API key with 401", async () => {
    const missing = await post(gw, { model: "m", prompt: "hi" }, null);
    expectStandardError(missing, "unauthorized");
    expect(missing.json["error"].code).toBe("missing_api_key");
    const wrong = await post(gw, { model: "m", prompt: "hi" }, "not-a-key");
    expectStandardError(wrong, "unauthorized");
    expect(wrong.json["error"].code).toBe("invalid_api_key");
    expect(primary.requests).toHaveLength(0);
  });

  it.each([
    ["invalid JSON", undefined, "{not json", "invalid_json"],
    ["a JSON array", [1, 2], undefined, "invalid_body"],
    ["a missing prompt", { model: "m" }, undefined, "invalid_prompt"],
    ["an empty model", { model: "", prompt: "hi" }, undefined, "invalid_model"],
    ["a non-integer max_tokens", { model: "m", prompt: "hi", max_tokens: 1.5 }, undefined, "invalid_max_tokens"],
    ["an unknown field", { model: "m", prompt: "hi", temperature: 2 }, undefined, "unknown_field"],
  ])("rejects %s with 400", async (_label, body, raw, code) => {
    const r = await post(gw, body, KEYS.main, raw);
    expectStandardError(r, "invalid_request");
    expect(r.json["error"].code).toBe(code);
  });

  it("rejects a body over the byte cap with 413", async () => {
    const r = await post(gw, { model: "m", prompt: "x".repeat(100 * 1024) });
    expectStandardError(r, "request_too_large");
    expect(r.json["error"].code).toBe("body_too_large");
  });

  it("returns 404 and 405 in the standard shape", async () => {
    const nf = await fetch(`${gw.url}/v1/nope`);
    const nfText = await nf.text();
    expectStandardError({ res: nf, text: nfText, json: JSON.parse(nfText) }, "not_found");
    const na = await fetch(`${gw.url}/v1/completions`);
    const naText = await na.text();
    expectStandardError({ res: na, text: naText, json: JSON.parse(naText) }, "method_not_allowed");
    expect(na.headers.get("allow")).toBe("POST"); // RFC 9110: a 405 must say what is allowed
    const hz = await fetch(`${gw.url}/healthz`, { method: "POST" });
    await hz.text();
    expect(hz.status).toBe(405);
    expect(hz.headers.get("allow")).toBe("GET");
  });

  it("authenticates before reading the body: a 401 arrives while the body is still being sent", async () => {
    const { port } = gw.server.address() as AddressInfo;
    const answer = await new Promise<{ head: string; closed: boolean }>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1");
      let head = "";
      s.on("error", reject);
      s.on("data", (d: Buffer) => (head += d.toString()));
      s.on("close", () => resolve({ head, closed: true }));
      // Declares 60 KiB (under the cap) but sends only 10 bytes and never finishes.
      s.write("POST /v1/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 61440\r\n\r\n");
      s.write('{"model":');
    });
    expect(answer.head).toMatch(/^HTTP\/1\.1 401 /);
    expect(answer.head.toLowerCase()).toContain("connection: close");
    expect(answer.closed).toBe(true);
  });

  it("checks the declared size before the key, and the key before the JSON", async () => {
    const big = await fetch(`${gw.url}/v1/completions`, {
      method: "POST",
      headers: { "content-length": String(1024 * 1024) },
      body: "x".repeat(1024 * 1024),
    });
    expect(big.status).toBe(413);
    await big.text();
    const r = await post(gw, undefined, null, "{not json");
    expectStandardError(r, "unauthorized");
  });

  it("bounds slow headers and slow bodies with Node's server timeouts (defaults 10 s / 30 s)", () => {
    expect(gw.server.headersTimeout).toBe(10_000);
    expect(gw.server.requestTimeout).toBe(30_000);
    const cfg = loadConfig({ REQUEST_TIMEOUT_MS: "20000", HEADERS_TIMEOUT_MS: "5000" });
    expect(cfg).toMatchObject({ requestTimeoutMs: 20_000, headersTimeoutMs: 5_000 });
    expect(loadConfig({})).toMatchObject({ requestTimeoutMs: 30_000, headersTimeoutMs: 10_000 });
    expect(() => loadConfig({ HEADERS_TIMEOUT_MS: "40000" })).toThrow(/HEADERS_TIMEOUT_MS/);
    const custom = createGatewayServer({ pipeline: gw.pipeline, db: gw.db, requestTimeoutMs: 20_000, headersTimeoutMs: 5_000 });
    expect(custom.requestTimeout).toBe(20_000);
    expect(custom.headersTimeout).toBe(5_000);
  });

  it("binds to loopback unless HOST says otherwise", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});

describe("error sanitization across every upstream failure", () => {
  const scenarios: Array<[string, MockBehaviour, MockBehaviour, keyof typeof ERROR_TYPES, boolean]> = [
    ["both 500", { kind: "serverError", status: 500 }, { kind: "serverError", status: 500 }, "upstream_unavailable", true],
    ["both malformed JSON", { kind: "badJson" }, { kind: "badJson" }, "upstream_unavailable", true],
    ["429 then 503", { kind: "rateLimit" }, { kind: "serverError", status: 503 }, "upstream_unavailable", true],
    ["both time out", { kind: "hang", ms: 5_000 }, { kind: "hang", ms: 5_000 }, "upstream_timeout", true],
    ["upstream 400", { kind: "clientError", status: 400 }, { kind: "ok" }, "upstream_rejected", false],
    ["upstream 422", { kind: "clientError", status: 422 }, { kind: "ok" }, "upstream_rejected", false],
    ["both 401/403", { kind: "clientError", status: 401 }, { kind: "clientError", status: 403 }, "upstream_unavailable", true],
  ];

  it.each(scenarios)("%s -> standard payload with no internals", async (_label, p, s, type, retryable) => {
    primary.setBehaviour(p);
    secondary.setBehaviour(s);
    const before = logs.length;
    const r = await post(gw, { model: "m", prompt: PROMPT });
    expectStandardError(r, type);
    expect(r.json["error"].retryable).toBe(retryable);
    expect(r.json["error"].message).toBe(ERROR_TYPES[type].message);
    // The detail went to the log under the same request id instead.
    const newLogs = logs.slice(before).join("\n");
    expect(newLogs).toContain(r.json["error"].request_id);
    // Nothing was charged for a request that produced no completion.
    const left = gw.db.prepare("SELECT COUNT(*) AS n FROM token_usage WHERE request_id = ?").get(r.json["error"].request_id);
    expect(left).toEqual({ n: 0 });
  });

  it("fails over when the primary returns 401 (gateway credential problem), visible as failed_over", async () => {
    primary.setBehaviour({ kind: "clientError", status: 401 });
    const r = await post(gw, { model: "m", prompt: PROMPT });
    expect(r.res.status).toBe(200);
    expect(r.json).toMatchObject({ provider: "secondary", failed_over: true });
  });

  it("logs the upstream detail that the client never sees", async () => {
    primary.setBehaviour({ kind: "serverError" });
    secondary.setBehaviour({ kind: "serverError" });
    const before = logs.length;
    const r = await post(gw, { model: "m", prompt: PROMPT });
    expect(r.text).not.toContain("upstream exploded");
    expect(logs.slice(before).join("\n")).toContain("upstream exploded");
  });

  it("network failure (ECONNREFUSED) on both providers -> 503 without internals", async () => {
    const dead = createMockProvider({ name: "dead" });
    const deadUrl = await dead.listen();
    await dead.close();
    const g = await startGateway(deadUrl, deadUrl, `${tmp.dir}/dead.db`);
    const before = logs.length;
    const r = await post(g, { model: "m", prompt: PROMPT });
    expectStandardError(r, "upstream_unavailable");
    expect(logs.slice(before).join("\n")).toContain("ECONNREFUSED");
  });

  it("database failure -> 500 internal without driver details", async () => {
    const g = await startGateway(primary.url(), secondary.url(), `${tmp.dir}/broken.db`);
    g.db.close(); // every statement now throws inside the driver
    const r = await post(g, { model: "m", prompt: PROMPT });
    expectStandardError(r, "internal");
    expect(r.json["error"].message).toBe("An internal error occurred.");
    const health = await fetch(`${g.url}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.text()).not.toMatch(FORBIDDEN);
  });

  it("never logs API keys or prompt text", () => {
    const all = logs.join("\n");
    for (const k of Object.values(KEYS)) expect(all).not.toContain(k);
    expect(all).not.toContain("upstream-primary-secret");
    expect(all).not.toContain("lighthouse");
  });
});

describe("concurrency", () => {
  it("admits exactly 10 of 20 parallel requests whose budget fits 10, and the window equals settled usage", async () => {
    // prompt of 40 chars -> 10 tokens + max_tokens 90 = 100 reserved each; limit 1000 -> 10 fit.
    // The mock reports exactly 100 tokens used, so settling frees nothing mid-burst.
    primary.setBehaviour({ kind: "ok", promptTokens: 10, completionTokens: 90, delayMs: 50 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => post(gw, { model: "m", prompt: "y".repeat(40), max_tokens: 90 }, KEYS.conc)),
    );
    const ok = results.filter((r) => r.res.status === 200);
    const limited = results.filter((r) => r.res.status === 429);
    expect(ok).toHaveLength(10);
    expect(limited).toHaveLength(10);
    for (const r of limited) expectStandardError(r, "rate_limited");
    const settled = ok.reduce((sum, r) => sum + (r.json["usage"].total_tokens as number), 0);
    const row = gw.db
      .prepare("SELECT SUM(tokens) AS s, COUNT(*) AS n, SUM(state = 'settled') AS settled FROM token_usage WHERE tenant_id = 't-conc'")
      .get();
    expect(row).toEqual({ s: settled, n: 10, settled: 10 });
    expect(settled).toBe(1000);
  });
});

describe("GET /healthz", () => {
  it("reports database status", async () => {
    const res = await fetch(`${gw.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
  });
});
