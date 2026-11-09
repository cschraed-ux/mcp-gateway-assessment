/**
 * Streaming PII redactor with pattern-aware hold-back.
 *
 * The redactor keeps a small `pending` string. On every push it appends the chunk, then asks each
 * detector's end-anchored `prefix` regex for the leftmost position from which the tail could still
 * become (or extend) a match. Everything before that position can never be part of a future
 * match, so it is scanned, redacted and emitted immediately; only the tail is held. For ordinary
 * prose the tail is the last word (it could be the local part of an e-mail), so latency added by
 * the guardrail is "one word", not "one response".
 *
 * Correctness: the scanner picks, at each step, the leftmost candidate across all detectors
 * (longest wins on a tie, then detector priority). A candidate that starts before the hold point
 * is final because no future text can change the regex result at a position whose suffix is not
 * a live prefix. So for any chunking, `push(...) + flush()` equals `redactText(fullText)` (the
 * property test checks this) as long as no live candidate is longer than `maxHold`.
 *
 * Memory: `pending` never exceeds `maxHold` characters after a push (default 320: an RFC-length
 * e-mail, 64-character local part + "@" + domain, is never cut by the cap; a separated 19-digit
 * card is 37 characters). The cap is only reached inside such a candidate: in prose the held
 * tail is the last word, so the larger cap costs no latency. Work per push is O(maxHold + chunk.length). Replacements are written only to the output,
 * never back into `pending`, so a `[REDACTED]` token can never be re-matched or held. One raw
 * character of already-emitted text is kept as left context so `\b` behaves exactly as it would
 * on the full text.
 */
import {
  DEFAULT_DETECTORS,
  isEmailLocalChar,
  orphanEmailTail,
  orphanEmailTailPrefix,
  type Detector,
  type PiiType,
} from "./detectors.js";

export const REDACTED = "[REDACTED]";

export interface RedactorOptions {
  /** Upper bound on held characters (default 320). Bounds both memory and added latency. */
  maxHold?: number;
  /** Emit `[REDACTED:EMAIL]` etc. instead of `[REDACTED]` (default false). */
  typedLabels?: boolean;
  detectors?: readonly Detector[];
}

export interface RedactorStats {
  charsIn: number;
  charsOut: number;
  heldChars: number;
  maxHeld: number;
  redactions: Record<PiiType, number> & { total: number };
}

interface Candidate {
  start: number;
  end: number;
  type: PiiType;
}

const emptyCounts = (): RedactorStats["redactions"] => ({ EMAIL: 0, SSN: 0, CREDIT_CARD: 0, total: 0 });

/** Leftmost accepted candidate of one detector at or after `from`. */
function findFrom(det: Detector, text: string, from: number): Candidate | null {
  const re = det.full;
  re.lastIndex = from;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return null;
    const len = det.accept(m[0]);
    if (len !== null) return { start: m.index, end: m.index + len, type: det.type };
    re.lastIndex = m.index + 1;
  }
}

/** Leftmost start >= `from` whose suffix matches one of `regexes` (all end-anchored). */
function leftmostLive(text: string, from: number, regexes: readonly RegExp[]): number {
  let h = text.length;
  for (const re of regexes) {
    re.lastIndex = from;
    const m = re.exec(text);
    if (m !== null && m.index < h) h = m.index;
  }
  return h;
}

interface Committed {
  out: string;
  end: number;
}

/** Length of a sticky regex match exactly at `at`, or 0. */
function matchAt(re: RegExp, text: string, at: number): number {
  re.lastIndex = at;
  const m = re.exec(text);
  return m === null ? 0 : m[0].length;
}

/**
 * Scans `text` from `from`, redacting every candidate that starts before `holdAt`, and returns
 * the output plus the position up to which raw text has been consumed (>= holdAt). With
 * `orphanTail`, an "@domain.tld" right at `from` is redacted too: its local part was already
 * released by an idle flush, so the e-mail detector alone can no longer see it.
 */
function commit(
  text: string,
  from: number,
  holdAt: number,
  detectors: readonly Detector[],
  label: (t: PiiType) => string,
  counts: RedactorStats["redactions"],
  orphanTail = false,
): Committed {
  let cursor = from;
  let out = "";
  const orphanLen = orphanTail ? matchAt(orphanEmailTail, text, from) : 0;
  if (orphanLen > 0) {
    out = label("EMAIL");
    counts.EMAIL++;
    counts.total++;
    cursor = from + orphanLen;
  }
  // undefined = not searched yet; null = no further match. Detectors whose literal hint is absent
  // start as null, so for plain prose most regexes never run at all.
  const cache: (Candidate | null | undefined)[] = detectors.map((d) => (d.hint.test(text) ? undefined : null));
  for (;;) {
    let best: Candidate | null = null;
    for (let i = 0; i < detectors.length; i++) {
      let c = cache[i];
      if (c === undefined || (c !== null && c.start < cursor)) {
        c = findFrom(detectors[i]!, text, cursor);
        cache[i] = c;
      }
      if (c === null) continue;
      if (best === null || c.start < best.start || (c.start === best.start && c.end > best.end)) best = c;
    }
    if (best === null || best.start >= holdAt) break;
    out += text.slice(cursor, best.start) + label(best.type);
    counts[best.type]++;
    counts.total++;
    cursor = best.end;
  }
  let end = Math.max(cursor, holdAt);
  // Never split a UTF-16 surrogate pair between an emitted and a held part. Only a real pair: a
  // lone high surrogate must not pull the next character (say a card's first digit) out with it.
  if (end > from && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end++;
  out += text.slice(cursor, end);
  return { out, end };
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

export class StreamRedactor {
  private pending = "";
  /** Last raw character already emitted: left context for `\b`. */
  private ctx = "";
  private readonly maxHold: number;
  private readonly detectors: readonly Detector[];
  private readonly prefixes: readonly RegExp[];
  private readonly strongPrefixes: readonly RegExp[];
  private readonly label: (t: PiiType) => string;
  private readonly counts = emptyCounts();
  private charsIn = 0;
  private charsOut = 0;
  private maxHeldSeen = 0;
  /** True right after an idle flush released text ending in a local-part character. */
  private orphanTail = false;

  constructor(opts: RedactorOptions = {}) {
    this.maxHold = Math.max(1, Math.floor(opts.maxHold ?? 320));
    this.detectors = opts.detectors ?? DEFAULT_DETECTORS;
    this.prefixes = this.detectors.map((d) => d.prefix);
    this.strongPrefixes = this.detectors.map((d) => d.strongPrefix);
    this.label = opts.typedLabels ? (t) => `[REDACTED:${t}]` : () => REDACTED;
  }

  /** Feeds one chunk; returns the text that is now safe to emit (possibly ""). */
  push(chunk: string): string {
    if (chunk.length === 0) return "";
    this.charsIn += chunk.length;
    const text = this.ctx + this.pending + chunk;
    const from = this.ctx.length;
    if (this.orphanTail && text.length - from <= this.maxHold && matchAt(orphanEmailTailPrefix, text, from) > 0) {
      // Still possibly the domain of an e-mail whose local part an idle flush released: hold it.
      this.pending = text.slice(from);
      if (this.pending.length > this.maxHeldSeen) this.maxHeldSeen = this.pending.length;
      return "";
    }
    const windowStart = Math.max(from, text.length - this.maxHold);
    const holdAt = leftmostLive(text, windowStart, this.prefixes);
    return this.emit(text, from, holdAt);
  }

  /** End of stream: runs the detectors one last time and returns everything still held. */
  flush(): string {
    const text = this.ctx + this.pending;
    return this.emit(text, this.ctx.length, text.length);
  }

  /**
   * Called when the upstream has gone quiet. Releases held text that has not made real progress
   * toward a pattern (a trailing plain word), keeps anything with an "@" or a digit run held.
   * This trades the exact streaming/full-text equivalence for liveness, so it is opt-in. If the
   * released word could be an e-mail's local part, an "@domain.tld" arriving next is still
   * redacted (only the local part, already sent, is exposed).
   */
  releaseIdle(): string {
    // While orphanTail is set, a non-empty pending is a held "@domain" tail: keep it.
    if (this.pending.length === 0 || this.orphanTail) return "";
    const text = this.ctx + this.pending;
    const from = this.ctx.length;
    const out = this.emit(text, from, leftmostLive(text, from, this.strongPrefixes));
    this.orphanTail = out !== "" && this.pending === "" && isEmailLocalChar(this.ctx);
    return out;
  }

  get heldChars(): number {
    return this.pending.length;
  }

  get maxHeld(): number {
    return this.maxHeldSeen;
  }

  get stats(): RedactorStats {
    return {
      charsIn: this.charsIn,
      charsOut: this.charsOut,
      heldChars: this.pending.length,
      maxHeld: this.maxHeldSeen,
      redactions: { ...this.counts },
    };
  }

  private emit(text: string, from: number, holdAt: number): string {
    const { out, end } = commit(text, from, holdAt, this.detectors, this.label, this.counts, this.orphanTail);
    this.orphanTail = false;
    if (end > from) this.ctx = text.slice(end - 1, end);
    this.pending = text.slice(end);
    if (this.pending.length > this.maxHeldSeen) this.maxHeldSeen = this.pending.length;
    this.charsOut += out.length;
    return out;
  }
}

/** Redacts a complete text in one pass: the reference the streaming path must agree with. */
export function redactText(fullText: string, opts: Omit<RedactorOptions, "maxHold"> = {}): string {
  const detectors = opts.detectors ?? DEFAULT_DETECTORS;
  const label = opts.typedLabels ? (t: PiiType) => `[REDACTED:${t}]` : () => REDACTED;
  return commit(fullText, 0, fullText.length, detectors, label, emptyCounts()).out;
}

export interface RedactorTransformOptions extends RedactorOptions {
  /** If > 0, release held plain words after this many ms without a chunk (default 0 = off). */
  idleFlushMs?: number;
  /** Injectable timer functions for deterministic tests. */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export type RedactorTransform = TransformStream<string, string> & { readonly redactor: StreamRedactor };

/** Web TransformStream wrapper: string chunks in, redacted string chunks out. */
export function createRedactorTransform(opts: RedactorTransformOptions = {}): RedactorTransform {
  const redactor = new StreamRedactor(opts);
  const idleMs = opts.idleFlushMs ?? 0;
  const timers = opts.timers ?? {
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };
  let timer: unknown = null;
  let done = false;
  const clear = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const ts = new TransformStream<string, string>({
    transform(chunk, controller) {
      clear();
      const out = redactor.push(chunk);
      if (out) controller.enqueue(out);
      if (idleMs > 0 && redactor.heldChars > 0) {
        timer = timers.setTimeout(() => {
          timer = null;
          if (done) return;
          const released = redactor.releaseIdle();
          if (!released) return;
          try {
            controller.enqueue(released);
          } catch {
            // Stream already closed or errored; nothing to deliver to.
          }
        }, idleMs);
      }
    },
    flush(controller) {
      done = true;
      clear();
      const out = redactor.flush();
      if (out) controller.enqueue(out);
    },
    cancel() {
      done = true;
      clear();
    },
  });
  return Object.assign(ts, { redactor });
}
