import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthenticator, parseStaticTokens, signToken } from "../src/auth.js";
import { createGateway, type GatewayOptions } from "../src/gateway.js";
import { createMockDownstream, MOCK_ROTATED_KEY, type RecordedRequest } from "../src/mock-downstream.js";
import { captureLogger, close, closedPort, listen } from "./helpers.js";

const SECRET = "gateway-test-secret-0123456789";
const adminToken = signToken({ role: "admin", sub: "alice" }, SECRET);
const viewerToken = signToken({ role: "viewer", sub: "bob" }, SECRET);
const authenticate = createAuthenticator({
  jwtSecret: SECRET,
  staticTokens: parseStaticTokens("static-admin-token:admin,static-viewer-token:viewer"),
});

const mock = createMockDownstream();
const { logger, lines } = captureLogger();
let downstreamBase = "";
let gatewayUrl = "";
let gateway: http.Server;

const extraServers: http.Server[] = [];

/** Starts an extra gateway with overrides (closed in afterAll). */
async function startGateway(overrides: Partial<GatewayOptions>): Promise<string> {
  const server = createGateway({ downstreamUrl: `${downstreamBase}/mcp`, authenticate, logger, ...overrides });
  extraServers.push(server);
  return `${await listen(server)}/mcp`;
}

async function post(url: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text, json: text === "" ? undefined : (JSON.parse(text) as any) };
}

async function downstreamLog(): Promise<RecordedRequest[]> {
  const res = await fetch(`${downstreamBase}/__requests`);
  return (await res.json()) as RecordedRequest[];
}

/** All JSON-RPC messages the downstream received, flattened across batches. */
async function downstreamMessages(): Promise<any[]> {
  return (await downstreamLog()).flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body]));
}

const req = (id: number | string | null, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const toolCall = (id: number | string, name: string, args: unknown = {}) => req(id, "tools/call", { name, arguments: args });

beforeAll(async () => {
  downstreamBase = await listen(mock.server);
  gateway = createGateway({ downstreamUrl: `${downstreamBase}/mcp`, authenticate, logger, upstreamTimeoutMs: 2000 });
  gatewayUrl = `${await listen(gateway)}/mcp`;
});

afterAll(async () => {
  await Promise.all([close(gateway), close(mock.server), ...extraServers.map(close)]);
});

beforeEach(async () => {
  await fetch(`${downstreamBase}/__requests`, { method: "DELETE" });
});

describe("forwarding", () => {
  it("forwards viewer tools/list transparently and returns the downstream tool list", async () => {
    const { res, json } = await post(gatewayUrl, req(1, "tools/list"), viewerToken);
    expect(res.status).toBe(200);
    expect(json.id).toBe(1);
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(["get_weather", "search_docs", "admin_reset_key", "admin_delete_user"]),
    );
    expect(await downstreamMessages()).toEqual([req(1, "tools/list")]);
  });

  it("forwards a viewer tools/call for get_weather", async () => {
    const { res, json } = await post(gatewayUrl, toolCall("w-1", "get_weather", { city: "Oslo" }), viewerToken);
    expect(res.status).toBe(200);
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: "w-1",
      result: { content: [{ type: "text", text: "Weather in Oslo: 21C, clear skies" }] },
    });
  });

  it("forwards an admin tools/call for admin_reset_key", async () => {
    const { res, json } = await post(gatewayUrl, toolCall(5, "admin_reset_key", { account: "acme" }), adminToken);
    expect(res.status).toBe(200);
    expect(json.result.content[0].text).toContain(MOCK_ROTATED_KEY);
    const calls = (await downstreamMessages()).filter((m) => m.method === "tools/call");
    expect(calls).toHaveLength(1);
  });

  it("echoes falsy ids 0 and empty string unchanged", async () => {
    expect((await post(gatewayUrl, req(0, "ping"), viewerToken)).json).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
    expect((await post(gatewayUrl, req("", "ping"), viewerToken)).json).toEqual({ jsonrpc: "2.0", id: "", result: {} });
  });

  it("passes downstream JSON-RPC errors through with HTTP 200", async () => {
    const { res, json } = await post(gatewayUrl, req(9, "does/not/exist"), viewerToken);
    expect(res.status).toBe(200);
    expect(json.error.code).toBe(-32601);
  });

  it("strips the client Authorization header and adds gateway headers downstream", async () => {
    await post(gatewayUrl, req(1, "tools/list"), viewerToken, { cookie: "session=abc", "x-forwarded-for": "203.0.113.9" });
    const [recorded] = await downstreamLog();
    expect(recorded?.headers.authorization).toBeUndefined();
    expect(recorded?.headers.cookie).toBeUndefined();
    expect(recorded?.headers["x-gateway-role"]).toBe("viewer");
    expect(recorded?.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
    expect(recorded?.headers["x-forwarded-for"]).toBe("203.0.113.9, 127.0.0.1");
  });

  it("sends the configured service credential downstream instead of the client token", async () => {
    const url = await startGateway({ downstreamAuthHeader: "Bearer service-credential" });
    await post(url, req(1, "ping"), adminToken);
    const [recorded] = await downstreamLog();
    expect(recorded?.headers.authorization).toBe("Bearer service-credential");
  });

  it("passes Mcp-Session-Id and Accept through in both directions", async () => {
    const init = await post(gatewayUrl, req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }), viewerToken);
    const sessionId = init.res.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    await post(gatewayUrl, req(2, "tools/list"), viewerToken, {
      "mcp-session-id": sessionId ?? "",
      accept: "application/json, text/event-stream",
    });
    const recorded = await downstreamLog();
    expect(recorded[1]?.headers["mcp-session-id"]).toBe(sessionId);
    expect(recorded[1]?.headers.accept).toBe("application/json, text/event-stream");
  });

  it("returns an x-request-id on every response", async () => {
    const ok = await post(gatewayUrl, req(1, "ping"), viewerToken);
    const denied = await post(gatewayUrl, req(1, "ping"));
    expect(ok.res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(denied.res.headers.get("x-request-id")).toBe(denied.json.error.data.requestId);
  });
});

describe("tool authorization", () => {
  it("denies a viewer calling admin_reset_key with 403 and -32001 without calling downstream", async () => {
    const { res, json, text } = await post(gatewayUrl, toolCall(42, "admin_reset_key", { account: "acme" }), viewerToken);
    expect(res.status).toBe(403);
    expect(json).toMatchObject({
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32001, message: "Unauthorized Tool Call", data: { tool: "admin_reset_key", requiredRole: "admin", role: "viewer" } },
    });
    expect(text).not.toContain(MOCK_ROTATED_KEY);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("denies mixed-case admin tool names for a viewer", async () => {
    const { res, json } = await post(gatewayUrl, toolCall(1, "ADMIN_delete_user"), viewerToken);
    expect(res.status).toBe(403);
    expect(json.error.code).toBe(-32001);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("rejects tools/call without params.name as -32602 and does not forward it", async () => {
    const { res, json } = await post(gatewayUrl, req(3, "tools/call", { arguments: {} }), adminToken);
    expect(res.status).toBe(400);
    expect(json.id).toBe(3);
    expect(json.error).toMatchObject({ code: -32602, message: "Invalid params" });
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("forwards nothing for a denied notification and answers 202", async () => {
    const note = { jsonrpc: "2.0", method: "tools/call", params: { name: "admin_reset_key" } };
    const { res, text } = await post(gatewayUrl, note, viewerToken);
    expect(res.status).toBe(202);
    expect(text).toBe("");
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("logs the denial as an audit event without the token", async () => {
    lines.length = 0;
    await post(gatewayUrl, toolCall(1, "admin_reset_key"), viewerToken);
    const denial = lines.map((l) => JSON.parse(l)).find((e) => e.msg === "tool_call_denied");
    expect(denial).toMatchObject({ tool: "admin_reset_key", role: "viewer", subject: "bob", level: "warn" });
    expect(lines.join("\n")).not.toContain(viewerToken);
  });
});

describe("authentication", () => {
  const unauthenticated = async (headers: Record<string, string>) => {
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(req(1, "tools/list")),
    });
    return { res, json: (await res.json()) as any };
  };

  it("rejects a request without Authorization with 401 -32002 before touching downstream", async () => {
    const { res, json } = await unauthenticated({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "Authentication required" } });
    expect(json.error.data.reason).toBe("missing_token");
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("rejects malformed, wrongly signed, alg none and expired tokens with 401 -32002", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none" })}.${b64({ role: "admin", exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    const tokens = {
      malformed: "not-a-jwt",
      wrongSignature: signToken({ role: "admin" }, "some-other-secret-value-123"),
      algNone: none,
      expired: signToken({ role: "admin" }, SECRET, Date.now() - 2 * 3600 * 1000),
    };
    for (const [name, token] of Object.entries(tokens)) {
      const { res, json } = await unauthenticated({ authorization: `Bearer ${token}` });
      expect(res.status, name).toBe(401);
      expect(json.error.code, name).toBe(-32002);
      expect(json.error.data.reason, name).toBe(name === "expired" ? "expired_token" : "invalid_token");
    }
    expect(await unauthenticated({ authorization: `Basic ${Buffer.from("a:b").toString("base64")}` })).toMatchObject({
      res: { status: 401 },
    });
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("does not trust a role sent as a plain header", async () => {
    const { res } = await unauthenticated({ "x-gateway-role": "admin", "x-role": "admin" });
    expect(res.status).toBe(401);
  });

  it("accepts tokens from the static token table", async () => {
    const viewer = await post(gatewayUrl, toolCall(1, "admin_reset_key"), "static-viewer-token");
    expect(viewer.res.status).toBe(403);
    const admin = await post(gatewayUrl, toolCall(2, "admin_reset_key"), "static-admin-token");
    expect(admin.res.status).toBe(200);
    expect(admin.json.result.content[0].text).toContain(MOCK_ROTATED_KEY);
  });
});

describe("wire format validation", () => {
  it("answers invalid JSON with 400 -32700 and id null", async () => {
    const { res, json } = await post(gatewayUrl, '{"jsonrpc": "2.0", "id": 1, "method": ', viewerToken);
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("answers JSON that is not an object or array with -32600", async () => {
    for (const body of ["42", '"x"', "null", "true"]) {
      const { res, json } = await post(gatewayUrl, body, viewerToken);
      expect(res.status).toBe(400);
      expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    }
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("answers a missing or wrong jsonrpc version with -32600 and id null", async () => {
    for (const body of [{ id: 1, method: "tools/list" }, { jsonrpc: "1.0", id: 1, method: "tools/list" }]) {
      const { res, json } = await post(gatewayUrl, body, viewerToken);
      expect(res.status).toBe(400);
      expect(json).toMatchObject({ id: null, error: { code: -32600, message: "Invalid Request" } });
    }
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("rejects a request with id null as -32600 (MCP forbids null ids) without forwarding it", async () => {
    const { res, json } = await post(gatewayUrl, req(null, "ping"), viewerToken);
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("answers a null-id item inside a batch on its own and forwards the rest", async () => {
    const { res, json } = await post(gatewayUrl, [req(null, "ping"), req(2, "ping")], viewerToken);
    expect(res.status).toBe(200);
    expect(json).toEqual([
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }),
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect(await downstreamMessages()).toEqual([req(2, "ping")]);
  });

  it("answers an empty batch with a single -32600", async () => {
    const { res, json } = await post(gatewayUrl, [], viewerToken);
    expect(res.status).toBe(400);
    expect(Array.isArray(json)).toBe(false);
    expect(json.error.code).toBe(-32600);
  });

  it("requires Content-Type application/json", async () => {
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify(req(1, "ping")),
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });

  it("accepts a charset parameter on the Content-Type", async () => {
    const { res } = await post(gatewayUrl, req(1, "ping"), viewerToken, { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });

  it("rejects bodies over MAX_BODY_BYTES with 413", async () => {
    const url = await startGateway({ maxBodyBytes: 256 });
    const { res, json } = await post(url, toolCall(1, "search_docs", { query: "x".repeat(1000) }), viewerToken);
    expect(res.status).toBe(413);
    expect(json.error.code).toBe(-32600);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("rejects a chunked body that grows past the cap and closes the socket", async () => {
    const url = new URL(await startGateway({ maxBodyBytes: 256 }));
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${viewerToken}`, "transfer-encoding": "chunked" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"');
      r.write("y".repeat(1024));
    });
    expect(status).toBe(413);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("rejects GET with 405", async () => {
    const res = await fetch(gatewayUrl, { headers: { authorization: `Bearer ${viewerToken}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });

  it("answers unknown paths with 404", async () => {
    const res = await fetch(gatewayUrl.replace("/mcp", "/other"), { method: "POST" });
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });
});

describe("batches", () => {
  it("splits a viewer batch: denies the admin call locally and forwards the rest as one batch", async () => {
    const batch = [
      req(1, "tools/list"),
      toolCall(2, "admin_reset_key", { account: "acme" }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      toolCall(3, "get_weather", { city: "Lima" }),
    ];
    const { res, json, text } = await post(gatewayUrl, batch, viewerToken);
    expect(res.status).toBe(200);
    expect(json).toHaveLength(3);
    expect(json.map((r: { id: unknown }) => r.id)).toEqual([1, 2, 3]);
    expect(json[0].result.tools.length).toBeGreaterThan(0);
    expect(json[1].error.code).toBe(-32001);
    expect(json[2].result.content[0].text).toContain("Lima");
    expect(text).not.toContain(MOCK_ROTATED_KEY);

    const recorded = await downstreamLog();
    expect(recorded).toHaveLength(1);
    const forwarded = recorded[0]?.body as any[];
    expect(Array.isArray(forwarded)).toBe(true);
    expect(forwarded.map((m) => m.method)).toEqual(["tools/list", "notifications/initialized", "tools/call"]);
    expect(forwarded.filter((m) => "id" in m)).toHaveLength(2);
  });

  it("answers a batch of only notifications with 202 and an empty body", async () => {
    const batch = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    ];
    const { res, text } = await post(gatewayUrl, batch, viewerToken);
    expect(res.status).toBe(202);
    expect(text).toBe("");
    expect((await downstreamMessages()).map((m) => m.method)).toEqual(["notifications/initialized", "notifications/cancelled"]);
  });

  it("answers invalid items inside a batch individually with id null", async () => {
    const { res, json } = await post(gatewayUrl, [1, req(7, "ping"), { jsonrpc: "2.0", id: 8 }], viewerToken);
    expect(res.status).toBe(200);
    expect(json).toEqual([
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }),
      { jsonrpc: "2.0", id: 7, result: {} },
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }),
    ]);
  });

  it("does not call downstream when every batch item is denied", async () => {
    const { res, json } = await post(gatewayUrl, [toolCall(1, "admin_reset_key"), toolCall(2, "admin_delete_user")], viewerToken);
    expect(res.status).toBe(200);
    expect(json.map((r: any) => r.error.code)).toEqual([-32001, -32001]);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("matches responses to duplicate and mixed-type ids in client order", async () => {
    const { json } = await post(gatewayUrl, [req("1", "ping"), req(1, "tools/list"), req(1, "ping")], viewerToken);
    expect(json.map((r: any) => r.id)).toEqual(["1", 1, 1]);
    expect(json[1].result.tools).toBeDefined();
    expect(json[2].result).toEqual({});
  });
});

describe("upstream failures", () => {
  const expectUpstreamError = (status: number, json: any, text: string, id: unknown) => {
    expect(status).toBe(502);
    expect(json).toMatchObject({ jsonrpc: "2.0", id, error: { code: -32003, message: "Upstream unavailable" } });
    expect(Object.keys(json.error.data)).toEqual(["requestId"]);
    for (const leak of ["ECONNREFUSED", "fetch failed", "Traceback", "hunter2", "db-7.internal", "127.0.0.1"]) {
      expect(text).not.toContain(leak);
    }
  };

  it("returns 502 -32003 when the downstream is unreachable, without upstream details", async () => {
    const port = await closedPort(http.createServer());
    const url = await startGateway({ downstreamUrl: `http://127.0.0.1:${port}/mcp` });
    lines.length = 0;
    const { res, json, text } = await post(url, req("a", "tools/list"), viewerToken);
    expectUpstreamError(res.status, json, text, "a");
    const failure = lines.map((l) => JSON.parse(l)).find((e) => e.msg === "upstream_failed");
    expect(failure).toMatchObject({ reason: "unreachable", requestId: json.error.data.requestId });
    expect(String(failure.cause)).toContain("ECONNREFUSED");
  });

  it("returns 502 -32003 when the downstream is slower than the timeout", async () => {
    const url = await startGateway({ upstreamTimeoutMs: 150 });
    const started = Date.now();
    const { res, json, text } = await post(url, toolCall(1, "slow_tool", { ms: 3000 }), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("returns 502 -32003 when the downstream answers with a ?delay= beyond the timeout", async () => {
    const url = await startGateway({ downstreamUrl: `${downstreamBase}/mcp?delay=3000`, upstreamTimeoutMs: 150 });
    const { res, json, text } = await post(url, req(1, "ping"), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
  });

  it("returns 502 -32003 for a non-2xx downstream status without copying its body", async () => {
    const url = await startGateway({ downstreamUrl: `${downstreamBase}/mcp?mode=500` });
    const { res, json, text } = await post(url, req(1, "ping"), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
  });

  it("returns 502 -32003 for a non-JSON downstream body", async () => {
    const url = await startGateway({ downstreamUrl: `${downstreamBase}/mcp?mode=text` });
    const { res, json, text } = await post(url, req(1, "ping"), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
  });

  it("returns 502 -32003 for an empty downstream body when a response was expected", async () => {
    const url = await startGateway({ downstreamUrl: `${downstreamBase}/mcp?mode=empty` });
    const { res, json, text } = await post(url, req(1, "ping"), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
  });

  it("returns 502 -32003 and logs when the downstream answers with SSE", async () => {
    const url = await startGateway({ downstreamUrl: `${downstreamBase}/mcp?mode=sse` });
    lines.length = 0;
    const { res, json, text } = await post(url, req(1, "tools/list"), viewerToken);
    expectUpstreamError(res.status, json, text, 1);
    expect(lines.some((l) => JSON.parse(l).msg === "SSE not supported by this gateway")).toBe(true);
  });

  it("keeps local denials and marks each forwarded id -32003 when a batch fails upstream", async () => {
    const port = await closedPort(http.createServer());
    const url = await startGateway({ downstreamUrl: `http://127.0.0.1:${port}/mcp` });
    const { res, json } = await post(url, [req(1, "tools/list"), toolCall(2, "admin_reset_key"), req(3, "ping")], viewerToken);
    expect(res.status).toBe(502);
    expect(json.map((r: any) => [r.id, r.error.code])).toEqual([
      [1, -32003],
      [2, -32001],
      [3, -32003],
    ]);
  });
});

describe("server timeouts", () => {
  it("bounds slow headers and slow bodies (defaults 10 s / 30 s, overridable)", () => {
    expect(gateway.headersTimeout).toBe(10_000);
    expect(gateway.requestTimeout).toBe(30_000);
    const custom = createGateway({ downstreamUrl: "http://127.0.0.1:1/mcp", authenticate, requestTimeoutMs: 5_000, headersTimeoutMs: 2_000 });
    expect(custom.requestTimeout).toBe(5_000);
    expect(custom.headersTimeout).toBe(2_000);
  });
});

describe("CORS and health", () => {
  it("answers a preflight from an allowed origin with CORS headers", async () => {
    const url = await startGateway({ corsAllowedOrigins: ["https://app.example.com"] });
    const res = await fetch(url, { method: "OPTIONS", headers: { origin: "https://app.example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-headers")).toContain("mcp-session-id");
  });

  it("refuses preflights and POSTs from origins that are not allowed (default: none)", async () => {
    const pre = await fetch(gatewayUrl, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const { res } = await post(gatewayUrl, req(1, "ping"), adminToken, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await downstreamLog()).toHaveLength(0);
  });

  it("serves GET /healthz without authentication", async () => {
    const res = await fetch(gatewayUrl.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
