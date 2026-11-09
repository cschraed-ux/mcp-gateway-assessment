/**
 * HTTP surface of the gateway, built on node:http only.
 *
 * The server's job is deliberately thin: assign a request id, route, refuse a declared
 * Content-Length over the byte cap, then hand the bearer key and a body loader to the pipeline,
 * which authenticates BEFORE the loader reads (still capped) and parses the body. Order:
 * route -> method -> size cap -> auth -> body read -> validate. A response sent before the body was
 * fully read closes the connection, so unread bytes are never consumed. Node's requestTimeout and
 * headersTimeout bound slow clients. Every error path
 * funnels through one function, `sendError`, which sanitises whatever was thrown into the
 * standard payload, logs the original (with stack and upstream detail) to stderr under the
 * request id, and writes only the safe payload to the client. The request id is generated here,
 * never taken from the client, so it is safe to put in logs and headers.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DB } from "./db.js";
import { GatewayError, sanitize } from "./errors.js";
import { type Logger, silentLogger } from "./logger.js";
import { type CompletionPipeline, rateLimitHeaders } from "./pipeline.js";

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface GatewayServerOptions {
  pipeline: CompletionPipeline;
  db: DB;
  logger?: Logger;
  maxBodyBytes?: number;
  /** Node's limit for receiving a whole request (slow-body defence). Default 30 s. */
  requestTimeoutMs?: number;
  /** Node's limit for receiving the request headers (slowloris defence). Default 10 s. */
  headersTimeoutMs?: number;
  newRequestId?: () => string;
}

class BodyTooLarge extends Error {}

function declaredTooLarge(req: IncomingMessage, cap: number): boolean {
  return Number(req.headers["content-length"] ?? "0") > cap;
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        req.removeAllListeners("data");
        req.resume(); // drain and discard the rest
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
}

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const logger = opts.logger ?? silentLogger;
  const cap = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const newId = opts.newRequestId ?? randomUUID;
  const ping = opts.db.prepare("SELECT 1 AS ok");

  const sendError = (res: ServerResponse, requestId: string, err: unknown): void => {
    const safe = sanitize(err);
    if (safe.status >= 500) logger.error("request failed", { request_id: requestId, type: safe.type, err: safe.internal ?? safe });
    else logger.info("request rejected", { request_id: requestId, type: safe.type, code: safe.code });
    sendJson(res, safe.status, safe.toPayload(requestId), { "x-request-id": requestId, ...safe.headers() });
  };

  /** Reads (capped) and parses the body; only called by the pipeline once the key is accepted. */
  const loadJson = async (req: IncomingMessage): Promise<unknown> => {
    let raw: Buffer;
    try {
      raw = await readBody(req, cap);
    } catch (err) {
      if (err instanceof BodyTooLarge) throw new GatewayError("request_too_large", { code: "body_too_large" });
      throw err;
    }
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new GatewayError("invalid_request", { code: "invalid_json", message: "Request body must be valid JSON." });
    }
  };

  const handleCompletion = async (req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> => {
    if (declaredTooLarge(req, cap)) throw new GatewayError("request_too_large", { code: "body_too_large" });
    const out = await opts.pipeline.complete(bearerToken(req), () => loadJson(req), requestId);
    const { result, providerUsed, failedOver } = out.route;
    sendJson(
      res,
      200,
      {
        id: requestId,
        model: result.model,
        provider: providerUsed,
        text: result.text,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.promptTokens + result.usage.completionTokens,
        },
        failed_over: failedOver,
      },
      { "x-request-id": requestId, ...rateLimitHeaders(out.rate) },
    );
    logger.info("request completed", {
      request_id: requestId,
      tenant_id: out.tenantId,
      provider: providerUsed,
      failed_over: failedOver,
      ...(out.route.failoverReason ? { failover_reason: out.route.failoverReason } : {}),
      attempts: out.route.attempts,
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET") throw new GatewayError("method_not_allowed", { headers: { allow: "GET" } });
      try {
        ping.get();
        sendJson(res, 200, { status: "ok", db: "ok" }, { "x-request-id": requestId });
      } catch (err) {
        logger.error("health check failed", { request_id: requestId, err });
        sendJson(res, 503, { status: "degraded", db: "unavailable" }, { "x-request-id": requestId });
      }
      return;
    }
    if (path === "/v1/completions") {
      if (req.method !== "POST") throw new GatewayError("method_not_allowed", { headers: { allow: "POST" } });
      await handleCompletion(req, res, requestId);
      return;
    }
    throw new GatewayError("not_found");
  };

  return createServer(
    { requestTimeout: opts.requestTimeoutMs ?? 30_000, headersTimeout: opts.headersTimeoutMs ?? 10_000 },
    (req, res) => {
      const requestId = newId();
      handle(req, res, requestId).catch((err: unknown) => {
        // Answering before the body was read (401, 413, ...): close instead of draining it.
        if (!req.complete) res.setHeader("connection", "close");
        try {
          sendError(res, requestId, err);
        } catch (fatal) {
          logger.error("failed to send error response", { request_id: requestId, err: fatal });
          res.destroy();
        }
      });
    },
  );
}
