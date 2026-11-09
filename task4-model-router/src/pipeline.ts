/**
 * The completion pipeline, independent of HTTP: authenticate -> read body -> validate -> reserve
 * tokens -> route (with failover) -> settle or release -> record. The body arrives as a loader
 * function so the HTTP layer can defer reading it until the API key has been accepted: an
 * unauthenticated caller gets its 401 without the gateway buffering or parsing anything.
 *
 * Accounting rule: exactly one of `settle` or `release` runs per admitted request, and it runs
 * only after `router.route` has settled its race, so a late primary result can never be counted.
 * On success the reservation becomes the provider's actual usage (prompt + completion), which may
 * be lower or higher than the estimate. On failure the reservation is released: the router only
 * returns an error when no provider produced a completion, so there is no usage to charge (see the
 * README for the trade-off around timed-out calls that an upstream may still bill). If the
 * database fails while settling a successful call, the client still gets its answer (with the
 * rate-limit headers from admission time) and the reservation stays at the (pessimistic) estimate;
 * the failure is logged.
 */
import { randomUUID } from "node:crypto";
import type { RequestLog, TenantStore } from "./db.js";
import { GatewayError, sanitize } from "./errors.js";
import { type Logger, silentLogger } from "./logger.js";
import type { CompletionRequest } from "./providers.js";
import type { SlidingWindowRateLimiter, WindowStatus } from "./rate-limiter.js";
import type { ModelRouter, RouteResult } from "./router.js";
import { DEFAULT_MAX_TOKENS, reservationFor } from "./tokens.js";

export const MAX_PROMPT_CHARS = 400_000;
export const MAX_COMPLETION_TOKENS = 32_768;
const ALLOWED_FIELDS = new Set(["model", "prompt", "max_tokens"]);

export interface CompletionSuccess {
  requestId: string;
  tenantId: string;
  route: RouteResult;
  rate: WindowStatus;
}

export interface CompletionPipelineOptions {
  tenants: TenantStore;
  limiter: SlidingWindowRateLimiter;
  router: ModelRouter;
  requestLog?: RequestLog;
  logger?: Logger;
  clock?: () => number;
}

const invalid = (code: string, message: string): GatewayError => new GatewayError("invalid_request", { code, message });

/** Validates the public request body. Messages are ours, so they are safe to return. */
export function parseCompletionBody(body: unknown): CompletionRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("invalid_body", "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!ALLOWED_FIELDS.has(key)) throw invalid("unknown_field", `Unknown field '${key.slice(0, 40)}'.`);
  }
  const { model, prompt, max_tokens } = b;
  if (typeof model !== "string" || model.length === 0 || model.length > 200) {
    throw invalid("invalid_model", "'model' must be a non-empty string of at most 200 characters.");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw invalid("invalid_prompt", "'prompt' must be a non-empty string.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GatewayError("request_too_large", { code: "prompt_too_large", message: "'prompt' is too long." });
  }
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (max_tokens !== undefined) {
    if (typeof max_tokens !== "number" || !Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_COMPLETION_TOKENS) {
      throw invalid("invalid_max_tokens", `'max_tokens' must be an integer between 1 and ${MAX_COMPLETION_TOKENS}.`);
    }
    maxTokens = max_tokens;
  }
  return { model, prompt, maxTokens };
}

export function rateLimitHeaders(s: WindowStatus): Record<string, string> {
  return {
    "x-ratelimit-limit": String(s.limit),
    "x-ratelimit-remaining": String(Math.max(0, s.remaining)),
    "x-ratelimit-reset-ms": String(Math.max(0, s.resetMs)),
  };
}

export class CompletionPipeline {
  private readonly tenants: TenantStore;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly router: ModelRouter;
  private readonly requestLog: RequestLog | undefined;
  private readonly logger: Logger;
  private readonly clock: () => number;

  constructor(opts: CompletionPipelineOptions) {
    this.tenants = opts.tenants;
    this.limiter = opts.limiter;
    this.router = opts.router;
    this.requestLog = opts.requestLog;
    this.logger = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * Runs the pipeline. `loadBody` is only called after authentication succeeds. Throws only
   * GatewayErrors (anything else is sanitised here).
   */
  async complete(
    apiKey: string | undefined,
    loadBody: () => unknown,
    requestId: string = randomUUID(),
  ): Promise<CompletionSuccess> {
    const started = this.clock();
    let tenantId: string | null = null;
    let model: string | null = null;
    try {
      // Authenticate before reading the body: unauthenticated callers learn nothing else and
      // cannot make the gateway buffer a body.
      if (!apiKey) throw new GatewayError("unauthorized", { code: "missing_api_key" });
      const tenant = this.tenants.findByApiKey(apiKey);
      if (!tenant) throw new GatewayError("unauthorized", { code: "invalid_api_key" });
      tenantId = tenant.tenantId;

      const req = parseCompletionBody(await loadBody());
      model = req.model;

      const estimate = reservationFor(req.prompt, req.maxTokens);
      const r = this.limiter.tryReserve(tenant.tenantId, tenant.tokensPerMinute, estimate, requestId);
      if (!r.allowed) {
        const status = this.limiter.status(tenant.tenantId, tenant.tokensPerMinute);
        if (r.reason === "request_exceeds_limit") {
          throw new GatewayError("request_too_large", {
            code: "request_exceeds_token_limit",
            message: "This request needs more tokens than the per-minute limit for this API key allows. Reduce the prompt or max_tokens.",
            headers: rateLimitHeaders(status),
          });
        }
        throw new GatewayError("rate_limited", {
          code: "token_rate_limit_exceeded",
          retryAfterMs: r.retryAfterMs,
          headers: rateLimitHeaders(status),
        });
      }

      let route: RouteResult;
      try {
        route = await this.router.route(req, requestId);
      } catch (err) {
        this.safely("release", () => this.limiter.release(requestId), requestId);
        throw err;
      }

      const { promptTokens, completionTokens } = route.result.usage;
      this.safely("settle", () => this.limiter.settle(requestId, promptTokens + completionTokens), requestId);
      let rate: WindowStatus;
      try {
        rate = this.limiter.status(tenant.tenantId, tenant.tokensPerMinute);
      } catch (err) {
        // Same promise as for settle: a database hiccup after a completion must not cost the answer.
        this.logger.error("rate limiter status failed", { request_id: requestId, err });
        rate = { usedInWindow: r.usedInWindow, remaining: r.remaining, limit: r.limit, resetMs: r.resetMs };
      }
      this.record(requestId, tenantId, model, route.providerUsed, 200, started, promptTokens, completionTokens, null);
      return { requestId, tenantId: tenant.tenantId, route, rate };
    } catch (err) {
      const safe = sanitize(err);
      this.record(requestId, tenantId, model, null, safe.status, started, null, null, safe.type);
      throw safe;
    }
  }

  private safely(what: string, fn: () => unknown, requestId: string): void {
    try {
      fn();
    } catch (err) {
      this.logger.error(`rate limiter ${what} failed`, { request_id: requestId, err });
    }
  }

  private record(
    requestId: string, tenantId: string | null, model: string | null, provider: string | null, status: number,
    started: number, promptTokens: number | null, completionTokens: number | null, errorType: string | null,
  ): void {
    if (!this.requestLog) return;
    try {
      this.requestLog.write({
        requestId, tenantId, modelRequested: model, providerUsed: provider, status,
        latencyMs: this.clock() - started, promptTokens, completionTokens, errorType, createdAt: started,
      });
    } catch (err) {
      this.logger.error("request log write failed", { request_id: requestId, err });
    }
  }
}
