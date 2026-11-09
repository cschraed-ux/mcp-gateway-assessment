/**
 * The gateway's one and only error contract.
 *
 * Every failure a caller can see is a `GatewayError` serialised by `toPayload()` into
 * `{ error: { code, type, message, request_id, retryable, retry_after_ms? } }`. The `type`
 * decides the HTTP status (table below) and the `message` is a fixed, generic sentence chosen
 * here, never text copied from an upstream provider, the database or a stack. Anything that is
 * not already a GatewayError goes through `sanitize()`, which turns it into `internal` (500) and
 * keeps the original only on the `internal` field, which the logger reads and `toPayload()` never does.
 * That way a forgotten `try/catch` can never leak a raw stack trace to a client.
 */

export type GatewayErrorType =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "request_too_large"
  | "rate_limited"
  | "internal"
  | "upstream_rejected"
  | "upstream_unavailable"
  | "upstream_timeout";

interface TypeSpec {
  status: number;
  retryable: boolean;
  message: string;
}

/** Type -> HTTP status, default retryability and the safe default message. */
export const ERROR_TYPES: Readonly<Record<GatewayErrorType, TypeSpec>> = {
  invalid_request: { status: 400, retryable: false, message: "The request is invalid." },
  unauthorized: { status: 401, retryable: false, message: "A valid API key is required." },
  not_found: { status: 404, retryable: false, message: "No such endpoint." },
  method_not_allowed: { status: 405, retryable: false, message: "Method not allowed for this endpoint." },
  request_too_large: { status: 413, retryable: false, message: "The request is too large." },
  rate_limited: { status: 429, retryable: true, message: "Token rate limit exceeded for this API key." },
  internal: { status: 500, retryable: true, message: "An internal error occurred." },
  upstream_rejected: {
    status: 502,
    retryable: false,
    message: "The model provider rejected the request.",
  },
  upstream_unavailable: {
    status: 503,
    retryable: true,
    message: "All model providers are currently unavailable. Please retry later.",
  },
  upstream_timeout: {
    status: 504,
    retryable: true,
    message: "The model providers did not respond in time. Please retry later.",
  },
};

export interface GatewayErrorOptions {
  /** Stable machine-readable code; defaults to the type. */
  code?: string;
  /** Safe, human message. Must never contain upstream or internal text. */
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Anything useful for debugging. Logged, never serialised into a payload. */
  internal?: unknown;
  /** Extra safe response headers (e.g. x-ratelimit-*). */
  headers?: Record<string, string>;
}

export interface GatewayErrorPayload {
  error: {
    code: string;
    type: GatewayErrorType;
    message: string;
    request_id: string;
    retryable: boolean;
    retry_after_ms?: number;
  };
}

export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly internal?: unknown;
  private readonly extraHeaders: Record<string, string>;

  constructor(type: GatewayErrorType, opts: GatewayErrorOptions = {}) {
    const spec = ERROR_TYPES[type];
    super(opts.message ?? spec.message);
    this.name = "GatewayError";
    this.type = type;
    this.code = opts.code ?? type;
    this.status = spec.status;
    this.retryable = opts.retryable ?? spec.retryable;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(opts.retryAfterMs));
    if (opts.internal !== undefined) this.internal = opts.internal;
    this.extraHeaders = { ...(opts.headers ?? {}) };
  }

  toPayload(requestId: string): GatewayErrorPayload {
    const error: GatewayErrorPayload["error"] = {
      code: this.code,
      type: this.type,
      message: this.message,
      request_id: requestId,
      retryable: this.retryable,
    };
    if (this.retryAfterMs !== undefined) error.retry_after_ms = this.retryAfterMs;
    return { error };
  }

  /** Extra response headers this error implies (Retry-After is whole seconds, rounded up). */
  headers(): Record<string, string> {
    const out = { ...this.extraHeaders };
    if (this.retryAfterMs !== undefined) out["retry-after"] = String(Math.max(1, Math.ceil(this.retryAfterMs / 1000)));
    return out;
  }
}

/** Anything thrown -> a GatewayError that is safe to show. Unknown errors become `internal`. */
export function sanitize(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  return new GatewayError("internal", { internal: err });
}
