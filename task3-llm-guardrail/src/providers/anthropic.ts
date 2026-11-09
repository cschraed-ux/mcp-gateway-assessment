/**
 * Anthropic Messages API adapter (`POST /v1/messages` with `stream: true`), raw `fetch` because
 * the task forbids runtime dependencies. The stream is a sequence of named SSE events:
 * `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`,
 * `message_delta`, `message_stop`, plus `ping` keep-alives and `error`. Only `text_delta` deltas
 * are user-visible text; `thinking_delta`, `signature_delta` and `input_json_delta` are skipped
 * (current models think adaptively by default, which shows up as a delay before the first
 * `text_delta`, not as text). The event-to-text step is a separate exported function so it can be
 * tested against a recorded fixture with no network.
 */
import { parseSSE, type SSEEvent } from "../sse.js";
import { UpstreamError, type GenerateRequest, type Provider } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** `anthropic-version` header (default "2023-06-01"). */
  apiVersion?: string;
  /** Server-side refusal fallback ("default" routes by refusal category). Off unless set, so an
   *  account without the beta is never rejected. */
  fallbacks?: "default" | null;
  defaultMaxTokens?: number;
  fetch?: typeof fetch;
}

interface AnthropicEvent {
  type?: string;
  delta?: { type?: string; text?: unknown };
  error?: { type?: unknown; message?: unknown };
}

/** Converts Anthropic stream events into text deltas. Throws on an `error` event. */
export async function* anthropicEventsToText(events: AsyncIterable<SSEEvent>): AsyncGenerator<string> {
  for await (const ev of events) {
    if (ev.event === "ping") continue;
    let payload: AnthropicEvent;
    try {
      payload = JSON.parse(ev.data) as AnthropicEvent;
    } catch {
      throw new UpstreamError("anthropic upstream sent a non-JSON event");
    }
    const type = payload.type ?? ev.event;
    if (type === "content_block_delta") {
      const d = payload.delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) yield d.text;
    } else if (type === "message_stop") {
      return;
    } else if (type === "error") {
      const kind = typeof payload.error?.type === "string" ? payload.error.type : "unknown_error";
      throw new UpstreamError(`anthropic stream error event: ${kind}`);
    }
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AnthropicOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async *stream(req: GenerateRequest, signal: AbortSignal): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.defaultModel ?? ANTHROPIC_DEFAULT_MODEL,
      max_tokens: req.maxTokens ?? this.opts.defaultMaxTokens ?? 64000,
      stream: true,
      messages: [{ role: "user", content: req.prompt }],
    };
    if (req.system) body["system"] = req.system;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": this.opts.apiKey,
      "anthropic-version": this.opts.apiVersion ?? "2023-06-01",
    };
    const fallbacks = this.opts.fallbacks ?? null;
    if (fallbacks !== null) {
      body["fallbacks"] = fallbacks;
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }

    const url = `${(this.opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
    const res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`anthropic upstream returned HTTP ${res.status}`, res.status);
    }
    yield* anthropicEventsToText(parseSSE(res.body));
  }
}
