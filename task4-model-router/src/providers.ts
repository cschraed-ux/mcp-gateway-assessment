/**
 * Model providers and the typed errors they raise.
 *
 * A provider turns a `CompletionRequest` into a `CompletionResult` and honours an AbortSignal for
 * the WHOLE call: connecting, waiting for headers and reading the body (the same signal is given to
 * fetch, which also aborts the body stream), so a timeout cannot be dodged by an upstream that sends
 * headers quickly and then trickles the body. Every failure is one of a few typed `UpstreamError`s
 * so the router can decide on failover by type, not by parsing strings. Upstream response bodies
 * and low-level causes (ECONNREFUSED, parse errors) are attached to `.internal` for the logger and
 * NEVER put in `.message`, so even an accidental `err.message` in a response leaks nothing useful.
 */

export interface CompletionRequest {
  /** Logical model name the client asked for (recorded; the provider maps it to its own model). */
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface ModelProvider {
  readonly name: string;
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
}

export type UpstreamErrorKind = "rate_limited" | "timeout" | "http_error" | "network_error" | "bad_response" | "aborted";

export abstract class UpstreamError extends Error {
  abstract readonly kind: UpstreamErrorKind;
  readonly provider: string;
  readonly internal?: unknown;

  constructor(provider: string, message: string, internal?: unknown) {
    super(message);
    this.provider = provider;
    if (internal !== undefined) this.internal = internal;
  }
}

export class UpstreamRateLimited extends UpstreamError {
  readonly kind = "rate_limited" as const;
  override readonly name = "UpstreamRateLimited";
  readonly retryAfterMs?: number;
  constructor(provider: string, retryAfterMs?: number, internal?: unknown) {
    super(provider, "upstream rate limited", internal);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class UpstreamTimeout extends UpstreamError {
  readonly kind = "timeout" as const;
  override readonly name = "UpstreamTimeout";
  readonly timeoutMs: number;
  constructor(provider: string, timeoutMs: number) {
    super(provider, `upstream timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export class UpstreamHttpError extends UpstreamError {
  readonly kind = "http_error" as const;
  override readonly name = "UpstreamHttpError";
  readonly status: number;
  constructor(provider: string, status: number, internal?: unknown) {
    super(provider, `upstream returned HTTP ${status}`, internal);
    this.status = status;
  }
}

export class UpstreamNetworkError extends UpstreamError {
  readonly kind = "network_error" as const;
  override readonly name = "UpstreamNetworkError";
  constructor(provider: string, internal?: unknown) {
    super(provider, "upstream network error", internal);
  }
}

export class UpstreamBadResponse extends UpstreamError {
  readonly kind = "bad_response" as const;
  override readonly name = "UpstreamBadResponse";
  constructor(provider: string, internal?: unknown) {
    super(provider, "upstream returned an unexpected response", internal);
  }
}

/** The call was cancelled by our own AbortSignal (the router has already moved on). */
export class UpstreamAborted extends UpstreamError {
  readonly kind = "aborted" as const;
  override readonly name = "UpstreamAborted";
  constructor(provider: string) {
    super(provider, "upstream call aborted");
  }
}

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const isAbortError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "AbortError" || (e as { name?: unknown }).name === "TimeoutError");

export interface HttpProviderOptions {
  name: string;
  /** Base URL of an OpenAI-compatible API, e.g. https://api.example.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Upstream model id to send; defaults to the request's model. */
  model?: string;
  /** Hard cap on the bytes read from an upstream body. */
  maxResponseBytes?: number;
  clock?: () => number;
}

const ERROR_BODY_SNIPPET = 2048;

/** OpenAI-compatible `POST {baseUrl}/chat/completions` provider. */
export class HttpProvider implements ModelProvider {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly maxResponseBytes: number;
  private readonly clock: () => number;

  constructor(opts: HttpProviderOptions) {
    this.name = opts.name;
    this.url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_048_576;
    this.clock = opts.clock ?? (() => Date.now());
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    try {
      return await this.call(req, signal);
    } catch (err) {
      if (signal.aborted) throw new UpstreamAborted(this.name);
      if (err instanceof UpstreamError) throw err;
      if (isAbortError(err)) throw new UpstreamAborted(this.name);
      throw new UpstreamNetworkError(this.name, err);
    }
  }

  private async call(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model ?? req.model,
        messages: [{ role: "user", content: req.prompt }],
        max_tokens: req.maxTokens,
      }),
      signal,
    });

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.clock());
      const body = await readCapped(res, ERROR_BODY_SNIPPET).catch(() => "");
      throw new UpstreamRateLimited(this.name, retryAfterMs, { status: 429, body });
    }
    if (!res.ok) {
      const body = await readCapped(res, ERROR_BODY_SNIPPET).catch(() => "");
      throw new UpstreamHttpError(this.name, res.status, { status: res.status, body });
    }

    const contentType = res.headers.get("content-type");
    const raw = await readCapped(res, this.maxResponseBytes, () =>
      new UpstreamBadResponse(this.name, { reason: "response too large", cap: this.maxResponseBytes }),
    );
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Only the size and type are logged: the body (and JSON.parse's message, which quotes it)
      // may contain completion text.
      throw new UpstreamBadResponse(this.name, { reason: "invalid JSON", bytes: Buffer.byteLength(raw), contentType });
    }
    return this.mapResponse(json);
  }

  private mapResponse(json: unknown): CompletionResult {
    const body = json as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
    const text = typeof choice?.message?.content === "string" ? choice.message.content : choice?.text;
    const p = body?.usage?.prompt_tokens;
    const c = body?.usage?.completion_tokens;
    if (typeof text !== "string" || !isCount(p) || !isCount(c)) {
      throw new UpstreamBadResponse(this.name, { reason: "unexpected shape" });
    }
    return {
      text,
      model: typeof body.model === "string" ? body.model : (this.model ?? "unknown"),
      usage: { promptTokens: p, completionTokens: c },
    };
  }
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Reads at most `cap` bytes of a body. Over the cap: truncate (error snippets) or, when
 * `onOverflow` is given (real responses), fail, so a hostile upstream cannot make us buffer
 * unbounded data.
 */
async function readCapped(res: Response, cap: number, onOverflow?: () => Error): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        if (onOverflow) throw onOverflow();
        chunks.push(value.subarray(0, value.byteLength - (size - cap)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}
