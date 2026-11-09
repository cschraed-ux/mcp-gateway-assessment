import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_TEXT } from "../src/demo-text.js";
import { createMockOpenAIServer } from "../src/mock-provider.js";
import { AnthropicProvider, anthropicEventsToText } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { UpstreamError } from "../src/providers/types.js";
import { parseSSE } from "../src/sse.js";

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

function sseBody(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

describe("OpenAI-compatible adapter against the mock SSE server", () => {
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createMockOpenAIServer({ chunkChars: 4, delayMs: 0 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("yields the text deltas in order", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl, apiKey: "x" });
    const deltas = await collect(p.stream({ prompt: "hi" }, new AbortController().signal));
    expect(deltas.length).toBeGreaterThan(10);
    expect(deltas.join("")).toBe(DEMO_TEXT);
  });

  it("throws UpstreamError with only the status on HTTP errors (no upstream body)", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl, apiKey: "x" });
    const err = await collect(p.stream({ prompt: "hi", model: "fail-401" }, new AbortController().signal)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(401);
    expect((err as Error).message).not.toMatch(/sk-test/);
  });

  it("throws on an in-stream error object", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl, apiKey: "x" });
    await expect(collect(p.stream({ prompt: "hi", model: "fail-midstream" }, new AbortController().signal))).rejects.toBeInstanceOf(UpstreamError);
  });

  it("sends the expected request shape", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(sseBody('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "http://up/v1/", apiKey: "k", fetch: fakeFetch });
    expect(await collect(p.stream({ prompt: "p", system: "s", maxTokens: 9, model: "m" }, new AbortController().signal))).toEqual(["ok"]);
    expect(seen!.url).toBe("http://up/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      model: "m",
      stream: true,
      max_tokens: 9,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "p" },
      ],
    });
  });
});

const ANTHROPIC_FIXTURE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  "event: ping\ndata: {\"type\": \"ping\"}\n\n",
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Mail jane"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"@example.com 😀"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

describe("Anthropic adapter", () => {
  it("extracts only text_delta text from a recorded event stream", async () => {
    expect(await collect(anthropicEventsToText(parseSSE(sseBody(ANTHROPIC_FIXTURE, 5))))).toEqual(["Mail jane", "@example.com 😀"]);
  });

  it("stops at message_stop even if more bytes follow", async () => {
    const extra = ANTHROPIC_FIXTURE + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"late"}}\n\n';
    expect((await collect(anthropicEventsToText(parseSSE(sseBody(extra))))).join("")).not.toMatch(/late/);
  });

  it("throws on an error event", async () => {
    const wire =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const got: string[] = [];
    const err = await (async () => {
      for await (const s of anthropicEventsToText(parseSSE(sseBody(wire)))) got.push(s);
    })().catch((e: unknown) => e);
    expect(got).toEqual(["Hi"]);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toMatch(/overloaded_error/);
  });

  it("sends the Messages API request with the right headers and body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(sseBody(ANTHROPIC_FIXTURE), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch });
    const text = (await collect(p.stream({ prompt: "hello", system: "be brief" }, new AbortController().signal))).join("");
    expect(text).toBe("Mail jane@example.com 😀");
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = seen!.init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["anthropic-beta"]).toBeUndefined();
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 64000,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      system: "be brief",
    });
  });

  it("sends the refusal fallback and its beta header only when opted in", async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      headers = init.headers as Record<string, string>;
      return new Response(sseBody(ANTHROPIC_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: "k", fallbacks: "default", fetch: fakeFetch });
    await collect(p.stream({ prompt: "x" }, new AbortController().signal));
    expect(body["fallbacks"]).toBe("default");
    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("omits fallbacks when disabled and reports HTTP errors by status only", async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      headers = init.headers as Record<string, string>;
      return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: "bad", fallbacks: null, fetch: fakeFetch });
    const err = await collect(p.stream({ prompt: "x" }, new AbortController().signal)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(401);
    expect((err as Error).message).not.toMatch(/invalid x-api-key/);
    expect(body["fallbacks"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});
