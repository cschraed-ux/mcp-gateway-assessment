// Benchmark: streams ~1 MB of synthetic text with PII through the redactor in small chunks and
// reports throughput, per-push latency and the largest hold-back. Run with `npm run bench`.
// Results go to stderr (stdout stays clean, like the rest of the project).
import { performance } from "node:perf_hooks";
import { StreamRedactor, redactText } from "../src/redactor.js";
import { randomText, seededRng } from "./helpers.js";

const TARGET = 1 << 20;
const rng = seededRng(42);
const parts: string[] = [];
let len = 0;
while (len < TARGET) {
  // Mostly prose with PII sprinkled in, like a real model answer.
  const p = rng() < 0.2 ? randomText(rng, true) + " " : "The quick brown fox jumps over the lazy dog while the model explains the answer in detail. ";
  parts.push(p);
  len += p.length;
}
const text = parts.join("").slice(0, TARGET);
const expected = redactText(text);

function run(chunkSize: number, maxHold: number): void {
  const r = new StreamRedactor({ maxHold });
  const out: string[] = [];
  const pushTimes: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < text.length; i += chunkSize) {
    const s = performance.now();
    out.push(r.push(text.slice(i, i + chunkSize)));
    pushTimes.push(performance.now() - s);
  }
  out.push(r.flush());
  const ms = performance.now() - t0;
  if (out.join("") !== expected) throw new Error(`maxHold=${maxHold} chunk=${chunkSize}: streaming output differs from full-text redaction`);
  pushTimes.sort((a, b) => a - b);
  const p = (q: number): string => ((pushTimes[Math.floor(q * (pushTimes.length - 1))] ?? 0) * 1000).toFixed(1);
  process.stderr.write(
    `maxHold=${String(maxHold).padStart(3)}  chunk=${String(chunkSize).padStart(4)}B  pushes=${String(pushTimes.length).padStart(7)}  ` +
      `throughput=${(text.length / (1 << 20) / (ms / 1000)).toFixed(1).padStart(6)} MB/s  ` +
      `push p50=${p(0.5)}us p99=${p(0.99)}us  maxHeld=${r.maxHeld} chars  redactions=${r.stats.redactions.total}\n`,
  );
}

process.stderr.write(`input: ${(text.length / (1 << 20)).toFixed(2)} MB (UTF-16 code units ~ bytes for ASCII)\n`);
for (let warm = 0; warm < 2; warm++) run(20, 320);
process.stderr.write("--- measured ---\n");
for (const maxHold of [320, 64]) for (const size of [1, 20, 64, 256, 4096]) run(size, maxHold);
const t0 = performance.now();
redactText(text);
process.stderr.write(`one-shot redactText (no streaming): ${(text.length / (1 << 20) / ((performance.now() - t0) / 1000)).toFixed(1)} MB/s\n`);
