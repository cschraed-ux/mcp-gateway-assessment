import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { createLogger } from "../src/logger.js";
import { MockProvider, type MockProviderOptions } from "../src/providers/mock.js";
import { UpstreamError } from "../src/providers/types.js";
import { REDACTED, redactText } from "../src/redactor.js";
import { parseSSE } from "../src/sse.js";

const TEXT = "Hi! Email me at jane.doe@example.com, my SSN is 123-45-6789 and card 4111 1111 1111 1111. Thanks, bye.";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function start(mock: MockProviderOptions, extra: { maxResponseBytes?: number } = {}): Promise<{ url: string; provider: MockProvider; logs: string[] }> {
  const logs: string[] = [];
  const provider = new MockProvider(mock);
  const server = createGateway({ provider, logger: createLogger("debug", (l) => logs.push(l)), ...extra });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/generate`, provider, logs };
}

const post = (url: string, body: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });

describe("streaming generate", () => {
  it("streams redacted deltas incrementally with TTFT well before the end", async () => {
    const { url, provider } = await start({ text: TEXT, chunking: { kind: "fixed", size: 1 }, delayMs: 2 });
    const t0 = performance.now();
    const res = await post(url, { prompt: "hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    let firstAt: number | null = null;
    let chunksAtFirst = -1;
    const deltas: string[] = [];
    let done: { stats: { ttft_ms: number; total_ms: number; redactions: Record<string, number>; max_held_chars: number } } | null = null;
    for await (const ev of parseSSE(res.body!)) {
      const data = JSON.parse(ev.data) as { delta?: string; done?: boolean };
      if (data.delta !== undefined) {
        if (firstAt === null) {
          firstAt = performance.now() - t0;
          chunksAtFirst = provider.emitted;
        }
        deltas.push(data.delta);
      }
      if (data.done) done = data as typeof done;
    }
    const totalAt = performance.now() - t0;

    expect(deltas.join("")).toBe(redactText(TEXT));
    expect(deltas.join("").split(REDACTED).length - 1).toBe(3);
    expect(deltas.length).toBeGreaterThan(10);
    expect(firstAt!).toBeLessThan(totalAt / 2);
    expect(chunksAtFirst).toBeLessThan(provider.totalChunks / 4);
    expect(done).not.toBeNull();
    expect(done!.stats.redactions).toEqual({ EMAIL: 1, SSN: 1, CREDIT_CARD: 1, total: 3 });
    expect(done!.stats.ttft_ms).toBeLessThan(done!.stats.total_ms);
    expect(done!.stats.max_held_chars).toBeLessThanOrEqual(320);
    process.stderr.write(`gateway ttft=${firstAt!.toFixed(1)}ms total=${totalAt.toFixed(1)}ms (server ttft=${done!.stats.ttft_ms}ms)\n`);
  });

  it("returns one JSON body for stream:false, still redacted", async () => {
    const { url } = await start({ text: TEXT, chunking: { kind: "fixed", size: 5 } });
    const res = await post(url, { prompt: "hi", stream: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; stats: { redactions: { total: number } } };
    expect(body.text).toBe(redactText(TEXT));
    expect(body.stats.redactions.total).toBe(3);
  });

  it("caps stream:false responses at maxResponseBytes", async () => {
    const { url } = await start({ text: "word ".repeat(1000), chunking: { kind: "fixed", size: 50 } }, { maxResponseBytes: 1000 });
    const res = await post(url, { prompt: "hi", stream: false });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("response_too_large");
  });

  it("forwards model, max_tokens and system to the provider", async () => {
    const { url, provider } = await start({ text: "ok" });
    await (await post(url, { prompt: "p", model: "m-1", max_tokens: 50, system: "s", stream: false })).json();
    expect(provider.lastRequest).toEqual({ prompt: "p", model: "m-1", maxTokens: 50, system: "s" });
  });
});

describe("validation", () => {
  it("bounds receiving the request with requestTimeout and headersTimeout (defaults and env)", () => {
    const logger = createLogger("silent");
    const def = createGateway({ provider: new MockProvider(), logger });
    expect(def.requestTimeout).toBe(30_000);
    expect(def.headersTimeout).toBe(10_000);
    const cfg = loadConfig({ REQUEST_TIMEOUT_MS: "5000", HEADERS_TIMEOUT_MS: "2000" });
    const custom = createGateway({ provider: new MockProvider(), logger, requestTimeoutMs: cfg.requestTimeoutMs, headersTimeoutMs: cfg.headersTimeoutMs });
    expect(custom.requestTimeout).toBe(5000);
    expect(custom.headersTimeout).toBe(2000);
    expect(loadConfig({}).requestTimeoutMs).toBe(30_000);
    expect(loadConfig({}).headersTimeoutMs).toBe(10_000);
  });

  it("idle flush is opt-in: IDLE_FLUSH_MS defaults to 0 and 250 turns it on", () => {
    expect(loadConfig({}).idleFlushMs).toBe(0);
    expect(loadConfig({ IDLE_FLUSH_MS: "250" }).idleFlushMs).toBe(250);
  });

  it("rejects invalid JSON with 400", async () => {
    const { url } = await start({ text: "x" });
    const res = await post(url, "{not json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("rejects a missing prompt with 400", async () => {
    const { url } = await start({ text: "x" });
    const res = await post(url, { model: "m" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("rejects wrong field types with 400", async () => {
    const { url } = await start({ text: "x" });
    for (const body of [{ prompt: "p", stream: "yes" }, { prompt: "p", max_tokens: -1 }, { prompt: 5 }, ["p"]]) {
      expect((await post(url, body)).status).toBe(400);
    }
  });

  it("rejects non-JSON content types, other methods and unknown routes", async () => {
    const { url } = await start({ text: "x" });
    expect((await fetch(url, { method: "POST", body: "prompt=x" })).status).toBe(415);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url.replace("/v1/generate", "/nope"))).status).toBe(404);
  });
});

describe("failure modes", () => {
  it("returns a sanitized 502 when the provider fails before the first byte", async () => {
    const { url, logs } = await start({ failBeforeFirst: new UpstreamError("upstream said: invalid key sk-secret-123 at /internal/path", 401) });
    const res = await post(url, { prompt: "hi" });
    expect(res.status).toBe(502);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string; request_id: string } };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(text).not.toMatch(/sk-secret|internal\/path|401/);
    expect(logs.join("")).toMatch(body.error.request_id);
  });

  it("sends an SSE error event when the provider fails mid-stream, and never flushes the held tail", async () => {
    const { url } = await start({ text: "Partial answer and then jane.d", chunking: { kind: "explicit", chunks: ["Partial answer ", "and then jane.d", "oe@example.com"] }, failAfterChunks: 2 });
    const res = await post(url, { prompt: "hi" });
    expect(res.status).toBe(200);
    const events = [];
    for await (const ev of parseSSE(res.body!)) events.push(ev);
    const last = events.at(-1)!;
    expect(last.event).toBe("error");
    expect((JSON.parse(last.data) as { error: { code: string } }).error.code).toBe("upstream_error");
    const deltas = events.filter((e) => e.event === "message").map((e) => (JSON.parse(e.data) as { delta: string }).delta).join("");
    expect(deltas).toBe("Partial answer and then ");
  });

  it("aborts the provider when the client disconnects", async () => {
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((r) => (resolveAborted = r));
    const { url, provider, logs } = await start({ text: "word ".repeat(10_000), chunking: { kind: "fixed", size: 5 }, delayMs: 1, onAbort: () => resolveAborted() });
    const ac = new AbortController();
    const res = await post(url, { prompt: "hi" }, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await aborted;
    expect(provider.lastSignal!.aborted).toBe(true);
    expect(provider.finished).toBe(false);
    await vi.waitFor(() => expect(logs.join("")).toMatch(/client_disconnected/));
    expect(logs.join("")).not.toMatch(/upstream_error/);
  });
});

describe("memory", () => {
  it("streams 2 MB with bounded hold-back and bounded heap growth", async () => {
    const phrase = "lorem ipsum dolor sit amet, contact a.b@example.com or 123-45-6789. ";
    const big = phrase.repeat(Math.ceil((2 << 20) / phrase.length)).slice(0, 2 << 20);
    const { url } = await start({ text: big, chunking: { kind: "fixed", size: 64 } });
    // Retained (not transient) heap is what proves there is no accumulation, so force a GC
    // before measuring. --expose-gc cannot be passed through vitest config, so enable it here.
    v8.setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    gc();
    const before = process.memoryUsage().heapUsed;
    let retainedMid = 0;
    const res = await post(url, { prompt: "hi" });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let bytes = 0;
    let tail = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      tail = (tail + value).slice(-2000);
      if (retainedMid === 0 && bytes > 1 << 20) {
        gc();
        retainedMid = process.memoryUsage().heapUsed - before;
      }
    }
    const doneEvent = JSON.parse(tail.slice(tail.lastIndexOf("data: ") + 6)) as { stats: { max_held_chars: number; chars_in: number } };
    expect(doneEvent.stats.chars_in).toBe(2 << 20);
    expect(doneEvent.stats.max_held_chars).toBeLessThanOrEqual(320);
    expect(bytes).toBeGreaterThan(1 << 20);
    const growthMb = retainedMid / (1 << 20);
    process.stderr.write(`memory: streamed ${(bytes / (1 << 20)).toFixed(1)} MB of SSE, retained heap growth mid-stream ${growthMb.toFixed(2)} MB\n`);
    expect(growthMb).toBeLessThan(20);
  });
});
