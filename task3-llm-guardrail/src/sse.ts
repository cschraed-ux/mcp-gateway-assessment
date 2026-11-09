/**
 * Minimal Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * `SSEParser.feed()` takes decoded text in arbitrary pieces and returns the events completed by
 * it, so events, lines and even a CRLF pair may be split anywhere across network chunks. Bytes are
 * decoded with one streaming `TextDecoder`, so a multi-byte UTF-8 character split across chunks
 * is reassembled instead of turning into U+FFFD. Multi-line `data:` fields are joined with "\n",
 * comments (`:`) are ignored, and an unterminated event at end of stream is discarded as the
 * spec requires. A single line is capped (`maxLineChars`) so a hostile upstream that never sends
 * a newline cannot grow the buffer without bound.
 */

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

export class SSEParser {
  private buf = "";
  private data: string[] = [];
  private eventType = "";
  private id: string | undefined;

  constructor(private readonly maxLineChars = 1 << 20) {}

  feed(text: string): SSEEvent[] {
    this.buf += text;
    const out: SSEEvent[] = [];
    let start = 0;
    let lf = this.buf.indexOf("\n");
    let cr = this.buf.indexOf("\r");
    for (;;) {
      // Search again only once the cursor has passed the last hit, so a large network chunk with
      // many lines is scanned once (linear), not once per line (quadratic).
      if (lf !== -1 && lf < start) lf = this.buf.indexOf("\n", start);
      if (cr !== -1 && cr < start) cr = this.buf.indexOf("\r", start);
      let eol: number;
      let next: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A trailing "\r" may be the first half of "\r\n": wait for the next chunk.
        if (cr === this.buf.length - 1) break;
        eol = cr;
        next = this.buf.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
      } else if (lf !== -1) {
        eol = lf;
        next = lf + 1;
      } else break;
      const ev = this.line(this.buf.slice(start, eol));
      if (ev) out.push(ev);
      start = next;
    }
    this.buf = this.buf.slice(start);
    if (this.buf.length > this.maxLineChars) throw new Error("SSE line exceeds limit");
    return out;
  }

  private line(line: string): SSEEvent | null {
    if (line === "") return this.dispatch();
    if (line.charCodeAt(0) === 58 /* ':' */) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      default:
        break; // "retry" and unknown fields are irrelevant to a proxy.
    }
    return null;
  }

  private dispatch(): SSEEvent | null {
    // Per the spec, a block without any `data:` line (e.g. only `event: x`) dispatches nothing.
    const hasData = this.data.length > 0;
    const ev: SSEEvent = { event: this.eventType || "message", data: this.data.join("\n") };
    if (this.id !== undefined) ev.id = this.id;
    this.data = [];
    this.eventType = "";
    return hasData ? ev : null;
  }
}

/** Parses a byte stream into SSE events as they complete. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, maxLineChars?: number): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parser = new SSEParser(maxLineChars);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) yield* parser.feed(tail);
  } finally {
    // Runs on normal end, on error, and when the consumer stops early (return()).
    await reader.cancel().catch(() => undefined);
  }
}
