/**
 * Standalone mock LLM server speaking the OpenAI-compatible Chat Completions streaming format, so
 * the gateway can be demoed end to end over real HTTP without an API key:
 *
 *   npm run dev:provider     # listens on 127.0.0.1:8083 (MOCK_PROVIDER_PORT)
 *
 * It streams DEMO_TEXT in small chunks (MOCK_CHUNK_CHARS, default 3) with a delay
 * (MOCK_DELAY_MS, default 40) so redaction is visible live in `curl -N`. Model "fail-401" returns
 * HTTP 401 and "fail-midstream" sends an error after a few chunks, for exercising error paths.
 */
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DEMO_TEXT } from "./demo-text.js";
import { createLogger } from "./logger.js";
import { chunkText } from "./providers/mock.js";

export interface MockServerOptions {
  text?: string;
  chunkChars?: number;
  delayMs?: number;
}

export function createMockOpenAIServer(opts: MockServerOptions = {}): http.Server {
  const text = opts.text ?? DEMO_TEXT;
  const chunks = chunkText(text, { kind: "fixed", size: opts.chunkChars ?? 3 });
  return http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"not found"}}');
        return;
      }
      let raw = "";
      for await (const c of req as AsyncIterable<Buffer>) raw += c.toString("utf8");
      let body: { model?: string; stream?: boolean } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"bad json"}}');
        return;
      }
      if (body.model === "fail-401") {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"secret upstream detail: key sk-test-123 invalid"}}');
        return;
      }
      const id = "chatcmpl-mock";
      const model = body.model ?? "mock-1";
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
        return;
      }
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(frame({ role: "assistant", content: "" }));
      try {
        let n = 0;
        for (const c of chunks) {
          if (opts.delayMs ?? 40) await sleep(opts.delayMs ?? 40, undefined, { signal: ac.signal });
          if (body.model === "fail-midstream" && n++ === 5) {
            res.end(`data: ${JSON.stringify({ error: { message: "overloaded" } })}\n\n`);
            return;
          }
          res.write(frame({ content: c }));
        }
        res.write(frame({}, "stop"));
        res.end("data: [DONE]\n\n");
      } catch {
        res.destroy();
      }
    })();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger();
  const port = Number(process.env["MOCK_PROVIDER_PORT"] ?? 8083);
  const server = createMockOpenAIServer({
    chunkChars: Number(process.env["MOCK_CHUNK_CHARS"] ?? 3),
    delayMs: Number(process.env["MOCK_DELAY_MS"] ?? 40),
  });
  server.listen(port, "127.0.0.1", () => log.info("mock_provider_listening", { url: `http://127.0.0.1:${port}/v1` }));
}
