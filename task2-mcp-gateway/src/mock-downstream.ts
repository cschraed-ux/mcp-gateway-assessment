/**
 * Mock downstream MCP server (plain HTTP JSON-RPC, no SSE) used by the tests and the demo.
 *
 * It implements just enough of MCP for the gateway to be exercised end to end: `initialize`
 * (which issues an `Mcp-Session-Id`), `ping`, `tools/list` and `tools/call` with canned
 * results. `admin_reset_key` returns an obviously fake new key, so if a denied call ever leaked
 * through the gateway a test would see it. Every request is recorded in memory (method, path,
 * headers, parsed body) and exposed on `GET /__requests` (and cleared with `DELETE /__requests`)
 * so tests can assert what did and did not reach the downstream. Failure modes for gateway
 * tests are selected per URL: `?delay=<ms>` delays the answer, `?mode=sse|text|500|empty`
 * answers with an SSE stream, a non-JSON body, an HTTP 500 or an empty 200; the `slow_tool`
 * tool sleeps for `arguments.ms` (default 2000).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createLogger, type Logger } from "./logger.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockDownstream {
  server: http.Server;
  requests: RecordedRequest[];
  reset(): void;
}

export const MOCK_ROTATED_KEY = "sk-mock-ROTATED-KEY-0000-do-not-leak";

export const MOCK_TOOLS = [
  {
    name: "get_weather",
    description: "Current weather for a city",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  {
    name: "search_docs",
    description: "Full-text search over the documentation",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "admin_reset_key",
    description: "Rotate the API key of an account (admin only)",
    inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
  },
  {
    name: "admin_delete_user",
    description: "Delete a user (admin only)",
    inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
  },
  {
    name: "slow_tool",
    description: "Sleeps for arguments.ms milliseconds (test helper)",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

function callTool(name: unknown, args: Obj): { result?: unknown; error?: Obj; delayMs?: number } {
  switch (name) {
    case "get_weather":
      return { result: text(`Weather in ${String(args.city ?? "somewhere")}: 21C, clear skies`) };
    case "search_docs":
      return { result: text(`3 documents match "${String(args.query ?? "")}"`) };
    case "admin_reset_key":
      return { result: text(`Key for ${String(args.account ?? "unknown")} rotated. New key: ${MOCK_ROTATED_KEY}`) };
    case "admin_delete_user":
      return { result: text(`User ${String(args.userId ?? "unknown")} deleted`) };
    case "slow_tool":
      return { result: text("finally done"), delayMs: typeof args.ms === "number" ? args.ms : 2000 };
    default:
      return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
  }
}

/** Handles one JSON-RPC message; returns null for notifications. */
function handleMessage(msg: unknown, sessionId: { value: string | null }): { response: Obj | null; delayMs: number } {
  if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { response: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, delayMs: 0 };
  }
  if (!Object.hasOwn(msg, "id")) return { response: null, delayMs: 0 };
  const id = msg.id;
  const params = isObj(msg.params) ? msg.params : {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize":
      sessionId.value = randomUUID();
      return {
        response: ok({
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mock-downstream", version: "1.0.0" },
        }),
        delayMs: 0,
      };
    case "ping":
      return { response: ok({}), delayMs: 0 };
    case "tools/list":
      return { response: ok({ tools: MOCK_TOOLS }), delayMs: 0 };
    case "tools/call": {
      const outcome = callTool(params.name, isObj(params.arguments) ? params.arguments : {});
      const response = outcome.error ? { jsonrpc: "2.0", id, error: outcome.error } : ok(outcome.result);
      return { response, delayMs: outcome.delayMs ?? 0 };
    }
    default:
      return { response: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, delayMs: 0 };
  }
}

export function createMockDownstream(options: { logger?: Logger } = {}): MockDownstream {
  const requests: RecordedRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const log = options.logger;

  const later = (ms: number, fn: () => void) => {
    if (ms <= 0) return fn();
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (url.pathname === "/__requests") {
      if (req.method === "DELETE") {
        requests.length = 0;
        res.writeHead(204).end();
      } else {
        send(200, requests);
      }
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep raw text
      }
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      log?.debug("mock_request", { path: url.pathname });

      if (url.pathname !== "/mcp") return send(404, { error: "not found" });
      if (req.method !== "POST") return send(405, { error: "method not allowed" });

      const mode = url.searchParams.get("mode");
      const delay = Number(url.searchParams.get("delay") ?? 0);
      if (mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        return;
      }
      if (mode === "text") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>upstream proxy error page: internal host db-7.internal</html>");
        return;
      }
      if (mode === "500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Traceback at /srv/secret/app.py line 42: SECRET_DB_PASSWORD=hunter2" }));
        return;
      }
      if (mode === "empty") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }

      if (typeof body === "string") {
        return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const session = { value: null as string | null };
      const messages = Array.isArray(body) ? body : [body];
      const handled = messages.map((m) => handleMessage(m, session));
      const responses = handled.flatMap((h) => (h.response === null ? [] : [h.response]));
      const wait = Math.max(delay, ...handled.map((h) => h.delayMs));
      const headers: Record<string, string> = session.value !== null ? { "mcp-session-id": session.value } : {};
      later(wait, () => {
        if (responses.length === 0) {
          if (!res.destroyed) res.writeHead(202, headers).end();
          return;
        }
        send(200, Array.isArray(body) ? responses : responses[0], headers);
      });
    });
  });

  server.on("close", () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  return { server, requests, reset: () => void (requests.length = 0) };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const logger = createLogger({ base: { service: "mock-downstream" } });
  const port = Number(process.env.PORT ?? 8081);
  const host = process.env.HOST ?? "127.0.0.1";
  const { server } = createMockDownstream({ logger });
  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    logger.info("mock downstream listening", { url: `http://${host}:${actualPort}/mcp` });
  });
  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
