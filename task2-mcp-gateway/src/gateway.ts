/**
 * The MCP gateway: an HTTP reverse proxy that authenticates, authorizes and forwards JSON-RPC.
 *
 * Pipeline per request: route and HTTP-method checks, Origin and Content-Type checks, bearer
 * authentication (before the body is read, so an unauthenticated client cannot make the gateway
 * buffer anything and gets nothing back, not even `tools/list`), a size-capped body read, JSON
 * parse, per-item JSON-RPC validation and policy, one downstream call carrying only the allowed
 * items, then a merge that answers in the client's order. The gateway re-serialises what it
 * forwards, so the downstream parses exactly the object the policy inspected (no
 * duplicate-key or parser-differential tricks). Request headers are forwarded from an
 * allow-list: the client's `Authorization` never reaches the downstream. Any downstream failure
 * becomes -32003 with no upstream text copied into the response; the detail goes to the log
 * under the request id that is also returned as `x-request-id`.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Authenticator, AuthFailureReason, Principal } from "./auth.js";
import { authorize, DEFAULT_TOOL_RULES, type ToolRule } from "./policy.js";
import { silentLogger, type Logger } from "./logger.js";
import {
  authenticationRequired,
  ErrorCode,
  errorObject,
  errorResponse,
  invalidRequest,
  isNotification,
  isPlainObject,
  isRequest,
  isResponse,
  parseError,
  parseJson,
  upstreamUnavailable,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";

export interface GatewayOptions {
  /** Full URL of the downstream MCP endpoint, e.g. http://127.0.0.1:8081/mcp. */
  downstreamUrl: string;
  authenticate: Authenticator;
  /** Path the gateway serves MCP on. Default "/mcp". */
  path?: string;
  upstreamTimeoutMs?: number;
  /** Node's limit for receiving a whole request (slow-body defence). Default 30 s. */
  requestTimeoutMs?: number;
  /** Node's limit for receiving the request headers (slowloris defence). Default 10 s. */
  headersTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Cap on the downstream response body. Default 10 MiB. */
  maxUpstreamBodyBytes?: number;
  /** Cap on items in one batch. Default 100. */
  maxBatchItems?: number;
  /** Value sent as `Authorization` to the downstream (a service credential), if any. */
  downstreamAuthHeader?: string;
  /** Browser origins allowed by CORS; "*" allows any. Default: none. */
  corsAllowedOrigins?: readonly string[];
  rules?: readonly ToolRule[];
  logger?: Logger;
  generateRequestId?: () => string;
}

/** HTTP status for a response made entirely of one gateway-generated error. */
export const HTTP_STATUS_FOR_CODE: Readonly<Record<number, number>> = Object.freeze({
  [ErrorCode.ParseError]: 400,
  [ErrorCode.InvalidRequest]: 400,
  [ErrorCode.InvalidParams]: 400,
  [ErrorCode.AuthenticationRequired]: 401,
  [ErrorCode.UnauthorizedToolCall]: 403,
  [ErrorCode.UpstreamUnavailable]: 502,
  [ErrorCode.InternalError]: 500,
});

const CORS_ALLOW_HEADERS = "authorization, content-type, accept, mcp-session-id, mcp-protocol-version";
const CORS_EXPOSE_HEADERS = "mcp-session-id, x-request-id";
/** Request headers copied to the downstream; everything else (Authorization, cookies, hop-by-hop) is dropped. */
const PASSTHROUGH_REQUEST_HEADERS = ["accept", "mcp-session-id", "mcp-protocol-version"] as const;

/** What the gateway will do with one item of the client's payload. */
type Slot =
  | { kind: "local"; response: JsonRpcErrorResponse } // answered by the gateway
  | { kind: "forward-request"; message: JsonRpcRequest } // forwarded, response expected
  | { kind: "forward-notification"; message: JsonRpcMessage } // forwarded, no response
  | { kind: "dropped" }; // denied notification: no response allowed

type UpstreamOutcome =
  | { ok: true; responses: JsonRpcResponse[]; sessionId: string | null }
  | { ok: false; reason: string };

interface Entry {
  response: JsonRpcResponse;
  source: "gateway" | "downstream";
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  log: Logger;
}

function idKey(id: JsonRpcId): string {
  // JSON.stringify distinguishes 1 from "1" and keeps 0, "" and null distinct.
  return JSON.stringify(id);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader("cache-control", "no-store");
  if (body === undefined) {
    res.statusCode = status;
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Answers before (or instead of) reading the body; closes the connection so leftovers are discarded. */
function rejectEarly(ctx: RequestContext, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, { connection: "close", ...headers });
  ctx.req.resume();
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

type BodyResult = { ok: true; text: string } | { ok: false; reason: "too_large" | "aborted" };

/** Reads the request body, keeping at most `maxBytes` in memory. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) {
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        settle({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => settle({ ok: false, reason: "aborted" }));
    req.on("close", () => settle({ ok: false, reason: "aborted" }));
  });
}

/** Reads a fetch Response body as text with a byte cap; returns null when the cap is exceeded. */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clientAuthReason(reason: AuthFailureReason): string {
  if (reason === "missing_token") return "missing_token";
  if (reason === "expired") return "expired_token";
  return "invalid_token";
}

export function createGateway(options: GatewayOptions): http.Server {
  const path = options.path ?? "/mcp";
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxUpstreamBodyBytes = options.maxUpstreamBodyBytes ?? 10 * 1024 * 1024;
  const maxBatchItems = options.maxBatchItems ?? 100;
  const rules = options.rules ?? DEFAULT_TOOL_RULES;
  const logger = options.logger ?? silentLogger;
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const allowedOrigins = new Set(options.corsAllowedOrigins ?? []);

  const originAllowed = (origin: string): boolean => allowedOrigins.has("*") || allowedOrigins.has(origin);

  /** Turns each client item into a Slot by validating it and running the policy. */
  function classify(item: unknown, principal: Principal, ctx: RequestContext): Slot {
    if (!isRequest(item) && !isNotification(item)) {
      return { kind: "local", response: invalidRequest({ requestId: ctx.requestId }) };
    }
    const decision = authorize(item, principal.role, rules);
    if (decision.decision === "forward") {
      return isRequest(item) ? { kind: "forward-request", message: item } : { kind: "forward-notification", message: item };
    }
    const params = item.params;
    ctx.log.warn("tool_call_denied", {
      reason: decision.reason,
      tool: isPlainObject(params) && typeof params.name === "string" ? params.name : null,
      role: principal.role,
      subject: principal.subject,
      notification: !isRequest(item),
    });
    if (!isRequest(item)) return { kind: "dropped" };
    const data = isPlainObject(decision.error.data) ? decision.error.data : {};
    const error = errorObject(decision.error.code, decision.error.message, { ...data, requestId: ctx.requestId });
    return { kind: "local", response: errorResponse(item.id, error) };
  }

  /** Sends the allowed items downstream as one HTTP request and validates what comes back. */
  async function callDownstream(
    payload: unknown,
    expectsResponse: boolean,
    principal: Principal,
    ctx: RequestContext,
  ): Promise<UpstreamOutcome> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "x-request-id": ctx.requestId,
      "x-gateway-role": principal.role,
    };
    for (const name of PASSTHROUGH_REQUEST_HEADERS) {
      const value = ctx.req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const remote = ctx.req.socket.remoteAddress ?? "unknown";
    const priorXff = ctx.req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = typeof priorXff === "string" && priorXff !== "" ? `${priorXff}, ${remote}` : remote;
    if (options.downstreamAuthHeader !== undefined) headers.authorization = options.downstreamAuthHeader;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, upstreamTimeoutMs);
    const onClientGone = () => {
      if (!ctx.res.writableFinished) controller.abort();
    };
    ctx.res.once("close", onClientGone);
    const failWith = (reason: string, detail: Record<string, unknown> = {}): UpstreamOutcome => {
      ctx.log.error("upstream_failed", { reason, downstreamUrl: options.downstreamUrl, ...detail });
      return { ok: false, reason };
    };

    try {
      let response: Response;
      try {
        response = await fetch(options.downstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
        return failWith(timedOut ? "timeout" : "unreachable", { cause });
      }

      const contentType = mediaType(response.headers.get("content-type") ?? undefined);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return failWith("bad_status", { status: response.status });
      }
      if (contentType === "text/event-stream") {
        await response.body?.cancel().catch(() => {});
        ctx.log.error("SSE not supported by this gateway", { downstreamUrl: options.downstreamUrl });
        return { ok: false, reason: "sse_not_supported" };
      }

      let text: string | null;
      try {
        text = await readCappedText(response, maxUpstreamBodyBytes);
      } catch (err) {
        return failWith(timedOut ? "timeout" : "body_read_failed", { cause: err instanceof Error ? err.message : String(err) });
      }
      if (text === null) return failWith("response_too_large", { maxUpstreamBodyBytes });

      const sessionId = response.headers.get("mcp-session-id");
      if (text.trim() === "") {
        return expectsResponse ? failWith("empty_body", { status: response.status }) : { ok: true, responses: [], sessionId };
      }
      if (contentType !== "application/json") return failWith("non_json", { contentType });
      const parsed = parseJson(text);
      if (!parsed.ok) return failWith("non_json", { contentType });

      const items = Array.isArray(payload) ? parsed.value : [parsed.value];
      if (!Array.isArray(items)) return failWith("shape_mismatch", { expected: "array" });
      const responses = items.filter(isResponse);
      if (responses.length !== items.length) {
        ctx.log.warn("upstream_invalid_items_dropped", { dropped: items.length - responses.length });
      }
      return { ok: true, responses, sessionId };
    } finally {
      clearTimeout(timer);
      ctx.res.off("close", onClientGone);
    }
  }

  /** Puts gateway errors and downstream responses back in the client's order. */
  function merge(slots: Slot[], outcome: UpstreamOutcome | null, ctx: RequestContext): Entry[] {
    const byId = new Map<string, JsonRpcResponse[]>();
    if (outcome?.ok) {
      for (const r of outcome.responses) {
        const queue = byId.get(idKey(r.id)) ?? [];
        queue.push(r);
        byId.set(idKey(r.id), queue);
      }
    }
    const entries: Entry[] = [];
    for (const slot of slots) {
      if (slot.kind === "local") entries.push({ response: slot.response, source: "gateway" });
      if (slot.kind !== "forward-request") continue;
      const id = slot.message.id;
      if (outcome === null || !outcome.ok) {
        entries.push({ response: upstreamUnavailable(id, { requestId: ctx.requestId }), source: "gateway" });
        continue;
      }
      const match = byId.get(idKey(id))?.shift();
      if (match === undefined) {
        ctx.log.error("upstream_missing_response", { id });
        entries.push({ response: upstreamUnavailable(id, { requestId: ctx.requestId }), source: "gateway" });
      } else {
        entries.push({ response: match, source: "downstream" });
      }
    }
    const unsolicited = [...byId.values()].reduce((n, q) => n + q.length, 0);
    if (unsolicited > 0) ctx.log.warn("upstream_unsolicited_responses_dropped", { count: unsolicited });
    return entries;
  }

  function statusFor(entries: Entry[], isBatchRequest: boolean, upstreamFailed: boolean): number {
    if (upstreamFailed) return 502;
    if (isBatchRequest) return 200;
    const only = entries[0];
    if (only === undefined || only.source === "downstream" || !("error" in only.response)) return 200;
    return HTTP_STATUS_FOR_CODE[only.response.error.code] ?? 500;
  }

  async function handle(ctx: RequestContext): Promise<{ status: number; role?: string; subject?: string; items?: number }> {
    const { req, res, requestId } = ctx;
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const origin = req.headers.origin;

    if (origin !== undefined && originAllowed(origin)) {
      res.setHeader("access-control-allow-origin", allowedOrigins.has("*") ? "*" : origin);
      res.setHeader("access-control-expose-headers", CORS_EXPOSE_HEADERS);
      res.setHeader("vary", "Origin");
    }

    if (url.pathname === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
      return { status: 200 };
    }
    if (url.pathname !== path) {
      rejectEarly(ctx, 404, invalidRequest({ requestId, detail: `not found; MCP is served on ${path}` }));
      return { status: 404 };
    }
    if (req.method === "OPTIONS") {
      if (origin !== undefined && !originAllowed(origin)) {
        rejectEarly(ctx, 403, undefined);
        return { status: 403 };
      }
      rejectEarly(ctx, 204, undefined, {
        allow: "POST, OPTIONS",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
        "access-control-max-age": "600",
      });
      return { status: 204 };
    }
    if (req.method !== "POST") {
      rejectEarly(ctx, 405, invalidRequest({ requestId, detail: "only POST is supported (no SSE stream on GET)" }), {
        allow: "POST, OPTIONS",
      });
      return { status: 405 };
    }
    // MCP Streamable HTTP: servers must validate Origin to stop DNS-rebinding attacks from browsers.
    if (origin !== undefined && !originAllowed(origin)) {
      rejectEarly(ctx, 403, invalidRequest({ requestId, detail: "origin not allowed" }));
      return { status: 403 };
    }
    if (mediaType(req.headers["content-type"]) !== "application/json") {
      rejectEarly(ctx, 415, invalidRequest({ requestId, detail: "Content-Type must be application/json" }));
      return { status: 415 };
    }

    const auth = options.authenticate(req.headers.authorization);
    if (!auth.ok) {
      ctx.log.warn("authentication_failed", { reason: auth.reason });
      const reason = clientAuthReason(auth.reason);
      rejectEarly(ctx, 401, authenticationRequired({ requestId, reason }), {
        "www-authenticate": `Bearer realm="mcp-gateway", error="${reason === "missing_token" ? "invalid_request" : "invalid_token"}"`,
      });
      return { status: 401 };
    }
    const principal: Principal = auth;
    const who = { role: principal.role, subject: principal.subject };

    const body = await readBody(req, maxBodyBytes);
    if (!body.ok) {
      if (body.reason === "too_large") {
        sendJson(res, 413, invalidRequest({ requestId, detail: `body exceeds ${maxBodyBytes} bytes` }), { connection: "close" });
        // Stop reading whatever the client is still sending.
        res.once("finish", () => req.socket.destroy());
        return { status: 413, ...who };
      }
      req.socket.destroy();
      return { status: 499, ...who };
    }

    const parsed = parseJson(body.text);
    if (!parsed.ok) {
      sendJson(res, 400, parseError({ requestId }));
      return { status: 400, ...who };
    }

    const isBatchRequest = Array.isArray(parsed.value);
    const items: unknown[] = isBatchRequest ? (parsed.value as unknown[]) : [parsed.value];
    if (items.length === 0 || items.length > maxBatchItems) {
      const detail = items.length === 0 ? "empty batch" : `batch exceeds ${maxBatchItems} items`;
      sendJson(res, 400, invalidRequest({ requestId, detail }));
      return { status: 400, ...who };
    }

    const slots = items.map((item) => classify(item, principal, ctx));
    const forwarded = slots.flatMap((s) => (s.kind === "forward-request" || s.kind === "forward-notification" ? [s.message] : []));
    const expectsResponse = slots.some((s) => s.kind === "forward-request");

    let outcome: UpstreamOutcome | null = null;
    if (forwarded.length > 0) {
      // Preserve batch-ness: a single object goes down as a single object.
      const payload = isBatchRequest ? forwarded : forwarded[0];
      outcome = await callDownstream(payload, expectsResponse, principal, ctx);
    }
    if (res.destroyed) return { status: 499, ...who };

    const entries = merge(slots, outcome, ctx);
    const upstreamFailed = outcome !== null && !outcome.ok;
    const headers: Record<string, string> = {};
    if (outcome?.ok && outcome.sessionId !== null) headers["mcp-session-id"] = outcome.sessionId;

    if (entries.length === 0) {
      // Every item was a notification (MCP Streamable HTTP: 202 Accepted, no body).
      const status = upstreamFailed ? 502 : 202;
      sendJson(res, status, undefined, headers);
      return { status, ...who, items: items.length };
    }
    const status = statusFor(entries, isBatchRequest, upstreamFailed && expectsResponse);
    const responseBody = isBatchRequest ? entries.map((e) => e.response) : entries[0]?.response;
    sendJson(res, status, responseBody, headers);
    return { status, ...who, items: items.length };
  }

  const serverOptions: http.ServerOptions = {
    requestTimeout: options.requestTimeoutMs ?? 30_000,
    headersTimeout: options.headersTimeoutMs ?? 10_000,
  };
  return http.createServer(serverOptions, (req, res) => {
    const requestId = generateRequestId();
    const started = performance.now();
    const log = logger.child({ requestId });
    res.setHeader("x-request-id", requestId);
    const ctx: RequestContext = { req, res, requestId, log };

    handle(ctx)
      .then((summary) => {
        log.info("request", {
          httpMethod: req.method,
          path: req.url?.split("?")[0],
          durationMs: Math.round(performance.now() - started),
          ...summary,
        });
      })
      .catch((err: unknown) => {
        log.error("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
        sendJson(res, 500, errorResponse(null, errorObject(ErrorCode.InternalError, "Internal error", { requestId })));
      });
  });
}
