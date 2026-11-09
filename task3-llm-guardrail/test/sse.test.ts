import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { SSEParser, parseSSE, type SSEEvent } from "../src/sse.js";
import { seededRng } from "./helpers.js";

function byteStream(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let prev = 0;
  for (const c of [...cuts, bytes.length]) {
    pieces.push(bytes.slice(prev, c));
    prev = c;
  }
  return new ReadableStream({
    pull(controller) {
      const p = pieces.shift();
      if (p === undefined) controller.close();
      else controller.enqueue(p);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
}

const WIRE =
  ": comment line\n" +
  "event: content_block_delta\n" +
  'data: {"text":"héllo 😀"}\n' +
  "\n" +
  "data: line one\r\n" +
  "data: line two\r\n" +
  "id: 42\r\n" +
  "\r\n" +
  "data:no-space\r" +
  "\r" +
  "data: [DONE]\n\n" +
  "data: unterminated at EOF";

const EXPECTED: SSEEvent[] = [
  { event: "content_block_delta", data: '{"text":"héllo 😀"}' },
  { event: "message", data: "line one\nline two", id: "42" },
  { event: "message", data: "no-space", id: "42" },
  { event: "message", data: "[DONE]", id: "42" },
];

describe("SSE parser", () => {
  it("parses LF, CRLF and CR line endings, comments, multi-line data and ids", async () => {
    expect(await collect(byteStream(new TextEncoder().encode(WIRE), []))).toEqual(EXPECTED);
  });

  it("gives the same events for every single split point (including mid-CRLF and mid-UTF-8)", async () => {
    const bytes = new TextEncoder().encode(WIRE);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await collect(byteStream(bytes, [cut]))).toEqual(EXPECTED);
    }
  });

  it("gives the same events for random multi-way splits and 1-byte chunks", async () => {
    const bytes = new TextEncoder().encode(WIRE);
    expect(await collect(byteStream(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)))).toEqual(EXPECTED);
    const rng = seededRng(11);
    for (let t = 0; t < 100; t++) {
      const cuts = [...new Set(Array.from({ length: 1 + Math.floor(rng() * 10) }, () => 1 + Math.floor(rng() * (bytes.length - 1))))].sort((a, b) => a - b);
      expect(await collect(byteStream(bytes, cuts))).toEqual(EXPECTED);
    }
  });

  it("reassembles a 4-byte UTF-8 character split across three chunks", async () => {
    const bytes = new TextEncoder().encode("data: 😀\n\n");
    const at = bytes.indexOf(0xf0);
    expect(await collect(byteStream(bytes, [at + 1, at + 3]))).toEqual([{ event: "message", data: "😀" }]);
  });

  it("caps a line that never ends", () => {
    const p = new SSEParser(100);
    expect(() => p.feed("data: " + "x".repeat(200))).toThrow(/limit/);
  });

  it("ignores blank lines with no fields (no empty events)", () => {
    expect(new SSEParser().feed("\n\n\r\n")).toEqual([]);
  });

  it("dispatches nothing for a block with an event field but no data (per spec)", () => {
    expect(new SSEParser().feed("event: keepalive\n\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("parses one 4 MB chunk of many events in linear time (LF and CR-only endings)", () => {
    for (const eol of ["\n", "\r"]) {
      const ev = `data: {"choices":[{"delta":{"content":"hello"}}]}${eol}${eol}`;
      const n = Math.ceil((4 << 20) / ev.length);
      const p = new SSEParser(8 << 20);
      const t0 = performance.now();
      const events = p.feed(ev.repeat(n) + "\n");
      // A per-line rescan of the buffer took seconds here; a linear scan takes milliseconds.
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(events.length).toBe(n);
    }
  });
});
