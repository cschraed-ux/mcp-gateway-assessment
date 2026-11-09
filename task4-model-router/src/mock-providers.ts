/**
 * Controllable mock of an OpenAI-compatible `POST /chat/completions` provider, for tests and the
 * README demo.
 *
 * Behaviour is switched at runtime, from code (`mock.setBehaviour(...)`) or over HTTP
 * (`POST /__behaviour` with the same JSON), so a demo can flip the primary to 429 and watch the
 * gateway fail over. Every request is recorded, including whether the CLIENT aborted it before a
 * response was finished; that is how tests prove the router really cancels the primary's socket
 * on timeout instead of leaving it running. Error bodies deliberately contain stack-trace-like
 * text, file paths and "ECONNREFUSED"/"sqlite" so tests can prove none of it reaches a client.
 * Run directly (`npm run dev:providers`) to start two instances on ports 8091 and 8092.
 */
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createLogger } from "./logger.js";

export type MockBehaviour =
  | { kind: "ok"; text?: string; promptTokens?: number; completionTokens?: number; delayMs?: number }
  | { kind: "rateLimit"; retryAfterSec?: number }
  | { kind: "hang"; ms: number }
  | { kind: "slowBody"; ms: number }
  | { kind: "serverError"; status?: number }
  | { kind: "badJson" }
  | { kind: "clientError"; status?: number };

export interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  body: unknown;
  aborted: boolean;
}

export interface MockProvider {
  readonly name: string;
  readonly server: Server;
  readonly requests: RecordedRequest[];
  /** Emits "aborted" (RecordedRequest) when a client cancels before the response finished. */
  readonly events: EventEmitter;
  setBehaviour(b: MockBehaviour): void;
  listen(port?: number, host?: string): Promise<string>;
  /** Base URL (e.g. http://127.0.0.1:1234/v1); valid after listen(). */
  url(): string;
  close(): Promise<void>;
}

const LEAKY_BODY =
  "Error: upstream exploded\n    at handler (/Users/someone/provider/src/handler.ts:42:7)\n" +
  "    at node:internal/process/task_queues:95:5\n    caused by ECONNREFUSED 10.0.0.7:5432 (sqlite pool)";

export function createMockProvider(opts: { name: string; behaviour?: MockBehaviour }): MockProvider {
  const name = opts.name;
  let behaviour: MockBehaviour = opts.behaviour ?? { kind: "ok" };
  const requests: RecordedRequest[] = [];
  const events = new EventEmitter();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });

  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body);
  };

  const completion = (b: Extract<MockBehaviour, { kind: "ok" }>, reqBody: unknown): string => {
    const model = (reqBody as { model?: unknown } | null)?.model;
    return JSON.stringify({
      id: "cmpl-mock",
      object: "chat.completion",
      model: typeof model === "string" ? model : `${name}-model`,
      choices: [{ index: 0, message: { role: "assistant", content: b.text ?? `hello from ${name}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: b.promptTokens ?? 10, completion_tokens: b.completionTokens ?? 20 },
    });
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = await readJson(req);

    if (path === "/__behaviour" && req.method === "POST") {
      behaviour = body as MockBehaviour;
      send(res, 200, JSON.stringify({ ok: true, behaviour }));
      return;
    }
    if (path === "/__requests" && req.method === "GET") {
      send(res, 200, JSON.stringify({ count: requests.length, aborted: requests.filter((r) => r.aborted).length }));
      return;
    }
    if (!path.endsWith("/chat/completions") || req.method !== "POST") {
      send(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }

    const record: RecordedRequest = { path, authorization: req.headers.authorization, body, aborted: false };
    requests.push(record);
    const pending: Array<ReturnType<typeof setTimeout>> = [];
    res.on("close", () => {
      if (!res.writableFinished) {
        record.aborted = true;
        for (const t of pending) {
          clearTimeout(t);
          timers.delete(t);
        }
        events.emit("aborted", record);
      }
    });

    const b = behaviour;
    switch (b.kind) {
      case "ok":
        if (b.delayMs) pending.push(later(b.delayMs, () => send(res, 200, completion(b, body))));
        else send(res, 200, completion(b, body));
        return;
      case "rateLimit":
        send(res, 429, JSON.stringify({ error: { message: LEAKY_BODY } }), { "retry-after": String(b.retryAfterSec ?? 7) });
        return;
      case "hang":
        pending.push(later(b.ms, () => send(res, 200, completion({ kind: "ok" }, body))));
        return;
      case "slowBody": {
        // Headers and half a body now, the rest after `ms`: proves timeouts cover the body read.
        const full = completion({ kind: "ok" }, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.write(full.slice(0, 10));
        pending.push(later(b.ms, () => res.end(full.slice(10))));
        return;
      }
      case "serverError":
        send(res, b.status ?? 500, JSON.stringify({ error: { message: LEAKY_BODY, stack: LEAKY_BODY } }));
        return;
      case "badJson":
        send(res, 200, `{"choices": [ <html>${LEAKY_BODY}`);
        return;
      case "clientError":
        send(res, b.status ?? 400, JSON.stringify({ error: { message: `invalid request: ${LEAKY_BODY}` } }));
        return;
    }
  });

  let baseUrl = "";
  return {
    name,
    server,
    requests,
    events,
    setBehaviour(b) {
      behaviour = b;
    },
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://${host}:${addr.port}/v1`;
          resolve(baseUrl);
        });
      });
    },
    url: () => baseUrl,
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  const log = createLogger({ level: "info" });
  const specs = [
    { name: "primary", port: Number(process.env["PRIMARY_MOCK_PORT"] ?? 8091) },
    { name: "secondary", port: Number(process.env["SECONDARY_MOCK_PORT"] ?? 8092) },
  ];
  const mocks = specs.map((s) => ({ ...s, mock: createMockProvider({ name: s.name }) }));
  for (const m of mocks) {
    const url = await m.mock.listen(m.port);
    log.info("mock provider listening", { provider: m.name, url, control: url.replace(/\/v1$/, "/__behaviour") });
  }
  const stop = (): void => {
    void Promise.all(mocks.map((m) => m.mock.close())).then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
