/**
 * Deterministic in-process provider for tests, demos and benchmarks. It replays canned text in
 * chunks chosen by a strategy (fixed size, random sizes from an injected RNG, or an explicit
 * list), with an optional per-chunk delay that honours the abort signal. Hooks expose what the
 * gateway did to it (the signal it received, how many chunks it produced, whether it was
 * aborted) so tests can assert on disconnect handling and time-to-first-token.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { GenerateRequest, Provider } from "./types.js";

export type Chunking =
  | { kind: "fixed"; size: number }
  | { kind: "random"; min: number; max: number; rng: () => number }
  | { kind: "explicit"; chunks: readonly string[] };

export interface MockProviderOptions {
  text?: string;
  chunking?: Chunking;
  delayMs?: number;
  /** Throw this before the first chunk (simulates an upstream 5xx/auth failure). */
  failBeforeFirst?: Error;
  /** Throw after this many chunks (simulates a mid-stream upstream failure). */
  failAfterChunks?: number;
  onAbort?: (signal: AbortSignal) => void;
}

/** Splits text into chunks according to a strategy. */
export function chunkText(text: string, chunking: Chunking): string[] {
  if (chunking.kind === "explicit") return [...chunking.chunks];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size =
      chunking.kind === "fixed"
        ? Math.max(1, chunking.size)
        : chunking.min + Math.floor(chunking.rng() * (chunking.max - chunking.min + 1));
    out.push(text.slice(i, i + Math.max(1, size)));
    i += Math.max(1, size);
  }
  return out;
}

export class MockProvider implements Provider {
  readonly name = "mock";
  /** Chunks produced so far by the most recent stream. */
  emitted = 0;
  totalChunks = 0;
  finished = false;
  lastSignal: AbortSignal | null = null;
  lastRequest: GenerateRequest | null = null;

  constructor(private readonly opts: MockProviderOptions = {}) {}

  async *stream(req: GenerateRequest, signal: AbortSignal): AsyncIterable<string> {
    this.lastRequest = req;
    this.lastSignal = signal;
    this.emitted = 0;
    this.finished = false;
    signal.addEventListener("abort", () => this.opts.onAbort?.(signal), { once: true });
    const text = this.opts.text ?? `You said: ${req.prompt}`;
    const chunks = chunkText(text, this.opts.chunking ?? { kind: "fixed", size: 4 });
    this.totalChunks = chunks.length;
    if (this.opts.failBeforeFirst) throw this.opts.failBeforeFirst;
    for (const c of chunks) {
      if (this.opts.failAfterChunks !== undefined && this.emitted >= this.opts.failAfterChunks) {
        throw new Error("mock upstream failed mid-stream");
      }
      if (this.opts.delayMs) await sleep(this.opts.delayMs, undefined, { signal });
      signal.throwIfAborted();
      this.emitted++;
      yield c;
    }
    this.finished = true;
  }
}
