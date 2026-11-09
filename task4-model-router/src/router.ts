/**
 * Model router: primary first, automatic failover to a secondary provider.
 *
 * Each attempt gets its own AbortController and its own timer. The provider call is raced against
 * the timer; if the timer wins we abort the controller (fetch then tears down the socket, so the
 * slow upstream stops costing us a connection) and move on. Three race-condition rules:
 *   1. The timer is ALWAYS cleared in `finally`, so no timer outlives an attempt.
 *   2. Once the race is settled the loser is ignored: a primary that answers at 3100ms after a
 *      3000ms timeout cannot change the outcome, and because only the router's return value is ever
 *      settled against the rate limiter, its tokens are never double-counted.
 *   3. A loser that rejects later is pre-caught, so it can never surface as an unhandledRejection.
 * Which failures fail over is one small predicate, `shouldFailover`: 429, timeouts, 5xx, network
 * errors, malformed responses and upstream 401/403 do (the backup may well succeed; a 401/403 means
 * the gateway's own credential or entitlement for that provider is broken, not the request); other
 * upstream 4xx client errors do not (the same request would fail the same way on the backup,
 * wasting time and budget).
 */
import { GatewayError } from "./errors.js";
import { type Logger, serializeError, silentLogger } from "./logger.js";
import {
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  UpstreamError,
  UpstreamHttpError,
  UpstreamRateLimited,
  UpstreamTimeout,
} from "./providers.js";

export type FailoverReason =
  | "rate_limited"
  | "timeout"
  | "server_error"
  | "network_error"
  | "bad_response"
  | "auth_error";

export interface AttemptReport {
  provider: string;
  outcome: "ok" | UpstreamError["kind"] | "internal";
  status?: number;
  latencyMs: number;
}

export interface RouteResult {
  result: CompletionResult;
  providerUsed: string;
  failedOver: boolean;
  failoverReason?: FailoverReason;
  attempts: AttemptReport[];
}

export interface ModelRouterOptions {
  primary: ModelProvider;
  secondary: ModelProvider;
  /** Per-attempt deadline covering connect, headers and body. */
  timeoutMs?: number;
  clock?: () => number;
  logger?: Logger;
}

/** Why an error would trigger failover, or undefined if it must not fail over. */
export function failoverReason(err: unknown): FailoverReason | undefined {
  if (!(err instanceof UpstreamError)) return undefined;
  switch (err.kind) {
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "network_error":
      return "network_error";
    case "bad_response":
      return "bad_response";
    case "http_error": {
      const status = (err as UpstreamHttpError).status;
      // 408 Request Timeout is transient like a timeout; other 4xx describe the request itself.
      if (status >= 500 || status === 408) return "server_error";
      // 401/403: OUR credential or entitlement for this provider is broken. The backup has its own
      // credential, so it can serve the (perfectly valid) request.
      if (status === 401 || status === 403) return "auth_error";
      return undefined;
    }
    case "aborted":
      return undefined;
  }
}

export function shouldFailover(err: unknown): boolean {
  return failoverReason(err) !== undefined;
}

export class ModelRouter {
  readonly timeoutMs: number;
  private readonly primary: ModelProvider;
  private readonly secondary: ModelProvider;
  private readonly clock: () => number;
  private readonly logger: Logger;

  constructor(opts: ModelRouterOptions) {
    this.primary = opts.primary;
    this.secondary = opts.secondary;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.clock = opts.clock ?? (() => Date.now());
    this.logger = opts.logger ?? silentLogger;
  }

  async route(req: CompletionRequest, requestId: string): Promise<RouteResult> {
    const attempts: AttemptReport[] = [];
    let primaryErr: unknown;
    try {
      const result = await this.attempt(this.primary, req, attempts);
      return { result, providerUsed: this.primary.name, failedOver: false, attempts };
    } catch (err) {
      primaryErr = err;
    }

    const reason = failoverReason(primaryErr);
    if (reason === undefined) {
      this.logger.warn("primary failed, not failing over", { request_id: requestId, provider: this.primary.name, err: primaryErr });
      throw this.toGatewayError(primaryErr, undefined, attempts);
    }
    this.logger.warn("failing over to secondary", {
      request_id: requestId,
      from: this.primary.name,
      to: this.secondary.name,
      reason,
      err: primaryErr,
    });

    try {
      const result = await this.attempt(this.secondary, req, attempts);
      return { result, providerUsed: this.secondary.name, failedOver: true, failoverReason: reason, attempts };
    } catch (secondaryErr) {
      this.logger.warn("secondary failed", { request_id: requestId, provider: this.secondary.name, err: secondaryErr });
      throw this.toGatewayError(primaryErr, secondaryErr, attempts);
    }
  }

  /** One provider call bounded by a fresh timeout. */
  private async attempt(provider: ModelProvider, req: CompletionRequest, attempts: AttemptReport[]): Promise<CompletionResult> {
    const started = this.clock();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new UpstreamTimeout(provider.name, this.timeoutMs);
        reject(err);
        controller.abort(err); // releases the upstream socket; the late result, if any, is dropped
      }, this.timeoutMs);
    });
    // Promise.resolve().then(): a provider that throws synchronously still yields a rejection.
    const call = Promise.resolve().then(() => provider.complete(req, controller.signal));
    call.catch(() => undefined); // rule 3: a late loser must never become an unhandled rejection

    try {
      const result = await Promise.race([call, deadline]);
      attempts.push({ provider: provider.name, outcome: "ok", latencyMs: this.clock() - started });
      return result;
    } catch (err) {
      const report: AttemptReport = {
        provider: provider.name,
        outcome: err instanceof UpstreamError ? err.kind : "internal",
        latencyMs: this.clock() - started,
      };
      if (err instanceof UpstreamHttpError) report.status = err.status;
      attempts.push(report);
      throw err;
    } finally {
      clearTimeout(timer); // rule 1
      if (!controller.signal.aborted) controller.abort(); // nothing from this attempt keeps running
    }
  }

  /** Converts the attempt errors into the single safe error the client will see. */
  private toGatewayError(primaryErr: unknown, secondaryErr: unknown, attempts: AttemptReport[]): GatewayError {
    const internal = {
      attempts,
      primary: serializeError(primaryErr),
      ...(secondaryErr !== undefined ? { secondary: serializeError(secondaryErr) } : {}),
    };
    const last = secondaryErr ?? primaryErr;
    if (!(last instanceof UpstreamError)) return new GatewayError("internal", { internal });

    if (last instanceof UpstreamHttpError && !shouldFailover(last)) {
      return new GatewayError("upstream_rejected", { code: "upstream_rejected", internal });
    }
    if (primaryErr instanceof UpstreamTimeout && secondaryErr instanceof UpstreamTimeout) {
      return new GatewayError("upstream_timeout", { code: "all_providers_timed_out", internal });
    }
    // Only when every provider said "slow down" with a Retry-After can we promise a retry time.
    const failures = secondaryErr === undefined ? [primaryErr] : [primaryErr, secondaryErr];
    const retryAfters = failures
      .map((e) => (e instanceof UpstreamRateLimited ? e.retryAfterMs : undefined))
      .filter((v): v is number => v !== undefined);
    return new GatewayError("upstream_unavailable", {
      code: "all_providers_failed",
      internal,
      ...(retryAfters.length === failures.length ? { retryAfterMs: Math.min(...retryAfters) } : {}),
    });
  }
}
