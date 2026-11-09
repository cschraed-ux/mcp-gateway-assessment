/**
 * OpenAI-compatible Chat Completions adapter (`POST {baseUrl}/chat/completions`, `stream: true`).
 * Works with OpenAI and with the many servers that speak the same wire format (vLLM, Ollama,
 * LiteLLM, the bundled mock). Each SSE `data:` line is a JSON chunk whose
 * `choices[0].delta.content` is the next text delta; `data: [DONE]` ends the stream. The upstream
 * body is never surfaced: on a non-2xx status only the status code goes into the error.
 */
import { parseSSE } from "../sse.js";
import { UpstreamError, type GenerateRequest, type Provider } from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  fetch?: typeof fetch;
}

interface ChatChunk {
  choices?: { delta?: { content?: unknown } }[];
  error?: { message?: unknown };
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async *stream(req: GenerateRequest, signal: AbortSignal): AsyncIterable<string> {
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.defaultModel ?? "gpt-4o-mini",
      stream: true,
      messages,
    };
    if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;

    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`openai-compatible upstream returned HTTP ${res.status}`, res.status);
    }
    for await (const ev of parseSSE(res.body)) {
      if (ev.data === "[DONE]") return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(ev.data) as ChatChunk;
      } catch {
        throw new UpstreamError("openai-compatible upstream sent a non-JSON event");
      }
      if (chunk.error) throw new UpstreamError("openai-compatible upstream sent an error event");
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) yield content;
    }
  }
}
