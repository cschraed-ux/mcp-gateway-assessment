/**
 * HTTP layer: `POST /v1/generate` -> provider adapter -> StreamRedactor transform -> SSE writer.
 *
 * Latency: the request is handed to the provider as soon as the body is parsed, Nagle is disabled
 * on the socket, and each redacted piece is written the moment the redactor releases it, with no
 * response-level buffering. Headers are committed when the first delta arrives or after
 * `firstByteGraceMs` (default 1 s), whichever is first. That short grace lets a fast upstream
 * failure (bad key, 429, 5xx: all answered within one round trip) be reported as a real HTTP 502
 * instead of a 200 that turns into an error event, while a slow-thinking model still gets its
 * connection established (an SSE comment is sent) long before any proxy idle timeout.
 *
 * Memory: nothing accumulates on the streaming path. Backpressure is honoured end to end: a slow
 * client pauses the SSE writer, which stops pulling from the redactor, which stops pulling from
 * the provider. Only `stream: false` collects output, because the client asked for one JSON body,
 * and it is capped at `maxResponseBytes`.
 *
 * Failure handling: client disconnect aborts the upstream request via AbortController; upstream
 * errors are logged with the request id and returned as a generic `upstream_error` (never the
 * upstream body); on a mid-stream error the held tail is discarded rather than flushed, because a
 * held tail is by construction text that might be the start of PII (fail closed).
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import type { Logger } from "./logger.js";
import type { GenerateRequest, Provider } from "./providers/types.js";
import { createRedactorTransform, type RedactorStats } from "./redactor.js";

export interface GatewayOptions {
  provider: Provider;
  logger: Logger;
  maxHoldChars?: number;
  idleFlushMs?: number;
  maxResponseBytes?: number;
  maxBodyBytes?: number;
  firstByteGraceMs?: number;
  /** Time allowed to receive the whole request (default 30 s); does not limit the streamed response. */
  requestTimeoutMs?: number;
  /** Time allowed to receive the request headers (default 10 s). */
  headersTimeoutMs?: number;
  now?: () => number;
}

interface ParsedBody {
  req: GenerateRequest;
  stream: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const MAX_PROMPT_CHARS = 400_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, requestId: string): void {
  sendJson(res, status, { error: { code, message, request_id: requestId } });
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function parseGenerateBody(raw: string): ParsedBody {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const bad = (msg: string): never => {
    throw new HttpError(400, "invalid_request", msg);
  };
  if (typeof b["prompt"] !== "string" || b["prompt"].trim() === "") bad("`prompt` must be a non-empty string");
  const prompt = b["prompt"] as string;
  if (prompt.length > MAX_PROMPT_CHARS) bad(`\`prompt\` exceeds ${MAX_PROMPT_CHARS} characters`);
  const req: GenerateRequest = { prompt };
  if (b["model"] !== undefined) {
    if (typeof b["model"] !== "string" || !MODEL_RE.test(b["model"])) bad("`model` must be a model id string");
    req.model = b["model"] as string;
  }
  if (b["max_tokens"] !== undefined) {
    const mt = b["max_tokens"];
    if (typeof mt !== "number" || !Number.isInteger(mt) || mt < 1 || mt > 128_000) {
      bad("`max_tokens` must be an integer between 1 and 128000");
    }
    req.maxTokens = mt as number;
  }
  if (b["system"] !== undefined) {
    if (typeof b["system"] !== "string") bad("`system` must be a string");
    req.system = b["system"] as string;
  }
  if (b["stream"] !== undefined && typeof b["stream"] !== "boolean") bad("`stream` must be a boolean");
  return { req, stream: b["stream"] !== false };
}

/** Resolves after the chunk is accepted by the socket, or when the client is gone. */
function write(res: http.ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

const sse = (data: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

function publicStats(s: RedactorStats, ttftMs: number | null, totalMs: number): Record<string, unknown> {
  return {
    ttft_ms: ttftMs === null ? null : Math.round(ttftMs * 100) / 100,
    total_ms: Math.round(totalMs * 100) / 100,
    chars_in: s.charsIn,
    chars_out: s.charsOut,
    max_held_chars: s.maxHeld,
    redactions: s.redactions,
  };
}

export function createGateway(opts: GatewayOptions): http.Server {
  const log = opts.logger;
  const now = opts.now ?? (() => performance.now());
  const maxHold = opts.maxHoldChars ?? 320;
  const idleFlushMs = opts.idleFlushMs ?? 0;
  const maxResponseBytes = opts.maxResponseBytes ?? 1 << 20;
  const maxBodyBytes = opts.maxBodyBytes ?? 1 << 20;
  const graceMs = opts.firstByteGraceMs ?? 1000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = now();
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/healthz" && req.method === "GET") return sendJson(res, 200, { ok: true, provider: opts.provider.name });
    if (path !== "/v1/generate") return sendError(res, 404, "not_found", "no such route", requestId);
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return sendError(res, 405, "method_not_allowed", "use POST", requestId);
    }
    const ctype = req.headers["content-type"] ?? "";
    if (!/^application\/json\b/i.test(ctype)) {
      return sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json", requestId);
    }

    let parsed: ParsedBody;
    try {
      parsed = parseGenerateBody(await readBody(req, maxBodyBytes));
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, requestId);
      throw err;
    }

    const ac = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true;
        ac.abort();
      }
    });
    req.socket.setNoDelay(true);

    log.info("request", {
      request_id: requestId,
      provider: opts.provider.name,
      stream: parsed.stream,
      prompt_chars: parsed.req.prompt.length,
    });

    // Start the upstream call immediately and remember when its first delta arrives.
    const it = opts.provider.stream(parsed.req, ac.signal)[Symbol.asyncIterator]();
    let upstreamFirstMs: number | null = null;
    const next = async (): Promise<IteratorResult<string>> => {
      const r = await it.next();
      if (!r.done && upstreamFirstMs === null) upstreamFirstMs = now() - t0;
      return r;
    };
    const firstResult = next();
    let pendingFirst: Promise<IteratorResult<string>> | null = firstResult;

    const transform = createRedactorTransform({ maxHold, idleFlushMs: parsed.stream ? idleFlushMs : 0 });
    const source = new ReadableStream<string>(
      {
        async pull(controller) {
          const p = pendingFirst ?? next();
          pendingFirst = null;
          const r = await p;
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        },
        async cancel() {
          await it.return?.();
        },
      },
      { highWaterMark: 0 },
    );
    const reader = source.pipeThrough(transform).getReader();
    const redactor = transform.redactor;

    const upstreamFailed = (err: unknown): void => {
      log.error("upstream_error", {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
        status: (err as { status?: number }).status ?? null,
      });
    };

    if (!parsed.stream) {
      const parts: string[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += Buffer.byteLength(value);
          if (bytes > maxResponseBytes) {
            ac.abort();
            await reader.cancel().catch(() => undefined);
            log.warn("response_too_large", { request_id: requestId, limit: maxResponseBytes });
            return sendError(res, 502, "response_too_large", `response exceeds ${maxResponseBytes} bytes; use stream: true`, requestId);
          }
          parts.push(value);
        }
      } catch (err) {
        if (clientGone) return;
        upstreamFailed(err);
        return sendError(res, 502, "upstream_error", "the upstream model provider failed", requestId);
      }
      const stats = publicStats(redactor.stats, null, now() - t0);
      log.info("complete", { request_id: requestId, ...summary(redactor.stats), total_ms: stats["total_ms"] as number });
      return sendJson(res, 200, { id: requestId, text: parts.join(""), stats });
    }

    // Wait briefly for the first delta so an immediate upstream failure can still be a 502.
    let graceTimer: NodeJS.Timeout | undefined;
    const first = await Promise.race([
      firstResult.then(
        () => "ok" as const,
        (err: unknown) => ({ err }),
      ),
      new Promise<"timeout">((resolve) => {
        graceTimer = setTimeout(() => resolve("timeout"), graceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    if (typeof first === "object") {
      await reader.cancel().catch(() => undefined);
      if (clientGone) return;
      upstreamFailed(first.err);
      return sendError(res, 502, "upstream_error", "the upstream model provider failed", requestId);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    if (first === "timeout") await write(res, ": waiting for upstream\n\n");

    let ttftMs: number | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttftMs === null) ttftMs = now() - t0;
        await write(res, sse({ delta: value }));
        if (clientGone) break;
      }
    } catch (err) {
      if (clientGone) {
        // The abort made the provider throw: a disconnect, not an upstream failure.
        log.info("client_disconnected", { request_id: requestId, ...summary(redactor.stats) });
        return;
      }
      upstreamFailed(err);
      await write(res, sse({ error: { code: "upstream_error", message: "the upstream model provider failed", request_id: requestId } }, "error"));
      res.end();
      return;
    }
    if (clientGone) {
      await reader.cancel().catch(() => undefined);
      log.info("client_disconnected", { request_id: requestId, ...summary(redactor.stats) });
      return;
    }
    const stats = publicStats(redactor.stats, ttftMs, now() - t0);
    await write(res, sse({ done: true, request_id: requestId, stats }));
    res.end();
    log.info("complete", {
      request_id: requestId,
      ...summary(redactor.stats),
      ttft_ms: stats["ttft_ms"] as number | null,
      upstream_first_delta_ms: upstreamFirstMs === null ? null : Math.round(upstreamFirstMs * 100) / 100,
      total_ms: stats["total_ms"] as number,
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const requestId = String(res.getHeader("x-request-id") ?? "");
      log.error("internal_error", { request_id: requestId, error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendError(res, 500, "internal_error", "internal error", requestId);
      else res.destroy();
    });
  });
  // Bound how long a client may take to send its request (slowloris); the response stream is not
  // covered by these timers, so long generations are unaffected.
  server.requestTimeout = opts.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts.headersTimeoutMs ?? 10_000;
  return server;
}

function summary(s: RedactorStats): { chars_in: number; chars_out: number; max_held_chars: number; redactions: Record<string, number> } {
  return { chars_in: s.charsIn, chars_out: s.charsOut, max_held_chars: s.maxHeld, redactions: s.redactions };
}
