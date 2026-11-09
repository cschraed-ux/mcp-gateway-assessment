/**
 * JSON-RPC 2.0 wire types, structural validators and the gateway's error constructors.
 *
 * The gateway never trusts that a payload is well-formed: every item is classified with the
 * strict guards below (`jsonrpc` must be exactly "2.0", `method` a string, `params` an object or
 * array when present, `id` a string or finite number when present; MCP forbids `null` request
 * ids, so a request with `"id": null` is invalid). Anything that is
 * neither a Request nor a Notification is answered with -32600 and is never forwarded. The id
 * rules follow the spec exactly: when the id cannot be determined (parse error, invalid request
 * object) the error carries `id: null`; otherwise the request's own id is echoed, including the
 * legitimate falsy values `0` and `""`. Gateway-defined errors live in the -32000..-32099
 * server range: -32001 Unauthorized Tool Call, -32002 Authentication required,
 * -32003 Upstream unavailable.
 */

export const JSONRPC_VERSION = "2.0" as const;

export type JsonRpcId = string | number | null;
export type JsonRpcParams = Record<string, unknown> | unknown[];

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Never null: MCP requires a string or number id on requests. */
  id: string | number;
  method: string;
  params?: JsonRpcParams;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: JsonRpcParams;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UnauthorizedToolCall: -32001,
  AuthenticationRequired: -32002,
  UpstreamUnavailable: -32003,
} as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function hasMessageEnvelope(value: unknown): value is Record<string, unknown> & { method: string } {
  if (!isPlainObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (typeof value.method !== "string") return false;
  if (Object.hasOwn(value, "params") && !isPlainObject(value.params) && !Array.isArray(value.params)) return false;
  return true;
}

/** A Request: valid envelope with a string or number `id` (MCP forbids `null`; responses may still carry it). */
export function isRequest(value: unknown): value is JsonRpcRequest {
  return hasMessageEnvelope(value) && Object.hasOwn(value, "id") && value.id !== null && isJsonRpcId(value.id);
}

/** A Notification: valid envelope with no `id` member at all. It never gets a response. */
export function isNotification(value: unknown): value is JsonRpcNotification {
  return hasMessageEnvelope(value) && !Object.hasOwn(value, "id");
}

export function isBatch(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A Response object: `id` plus exactly one of `result` / `error` (with numeric code, string message). */
export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!isPlainObject(value) || value.jsonrpc !== JSONRPC_VERSION) return false;
  if (!Object.hasOwn(value, "id") || !isJsonRpcId(value.id)) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  if (hasError) {
    const err = value.error;
    return isPlainObject(err) && Number.isInteger(err.code) && typeof err.message === "string";
  }
  return true;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false };

export function parseJson(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function errorObject(code: number, message: string, data?: unknown): JsonRpcErrorObject {
  return data === undefined ? { code, message } : { code, message, data };
}

export function errorResponse(id: JsonRpcId, error: JsonRpcErrorObject): JsonRpcErrorResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/** -32700: the body is not valid JSON. The id is always null. */
export function parseError(data?: unknown): JsonRpcErrorResponse {
  return errorResponse(null, errorObject(ErrorCode.ParseError, "Parse error", data));
}

/** -32600: not a valid Request/Notification object. The id is null because it cannot be trusted. */
export function invalidRequest(data?: unknown): JsonRpcErrorResponse {
  return errorResponse(null, errorObject(ErrorCode.InvalidRequest, "Invalid Request", data));
}

/** -32001: the caller's role may not invoke this tool. */
export function unauthorizedToolCall(id: JsonRpcId, data?: unknown): JsonRpcErrorResponse {
  return errorResponse(id, errorObject(ErrorCode.UnauthorizedToolCall, "Unauthorized Tool Call", data));
}

/** -32002: missing, invalid or expired bearer token. Sent before the body is read, so id is null. */
export function authenticationRequired(data?: unknown): JsonRpcErrorResponse {
  return errorResponse(null, errorObject(ErrorCode.AuthenticationRequired, "Authentication required", data));
}

/** -32003: the downstream server could not produce a usable answer. Upstream details are never included. */
export function upstreamUnavailable(id: JsonRpcId, data?: unknown): JsonRpcErrorResponse {
  return errorResponse(id, errorObject(ErrorCode.UpstreamUnavailable, "Upstream unavailable", data));
}
