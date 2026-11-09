/**
 * Provider abstraction. An adapter turns one generation request into an async iterable of plain
 * text deltas; everything provider-specific (wire format, auth, SSE event names) stays inside the
 * adapter, so the guardrail and the HTTP layer are written once. Errors carry a status and a
 * message that is safe for logs; the gateway never forwards either to the client verbatim.
 */

export interface GenerateRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  system?: string;
}

export interface Provider {
  readonly name: string;
  /** Yields text deltas only. Must stop promptly when `signal` aborts. */
  stream(req: GenerateRequest, signal: AbortSignal): AsyncIterable<string>;
}

/** Upstream failure. `message` is for logs only. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}
