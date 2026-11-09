# Task 2: MCP Gateway (JSON-RPC security reverse proxy)

A small HTTP reverse proxy that sits between an AI agent (MCP client) and a downstream MCP
server. It reads the caller's role from a verified `Bearer` token, inspects every JSON-RPC
message, forwards what is allowed and answers what is not, without ever letting a denied
`admin_*` tool call reach the downstream.

Built on Node 24 built-ins only (`node:http`, `node:crypto`, global `fetch`). No runtime
dependencies.

```
                       Authorization: Bearer <JWT>
 ┌──────────────┐   POST /mcp  (JSON-RPC 2.0, single or batch)   ┌──────────────────────────────────────────┐
 │  AI agent /  │ ─────────────────────────────────────────────► │               MCP Gateway :8080          │
 │  MCP client  │ ◄───────────────────────────────────────────── │                                          │
 └──────────────┘   JSON-RPC responses (+ x-request-id)          │  1 route / method / Origin / Content-Type│
                                                                 │  2 authenticate (HS256 JWT or static)    │
                     denied items are answered here ──────────── │  3 read body (byte cap) + parse JSON     │
                     (-32001, -32602, -32600) never forwarded    │  4 validate each item + authorize()      │
                                                                 │  5 forward allowed subset as ONE request │
                                                                 │  6 merge answers in client order         │
                                                                 └───────────────────┬──────────────────────┘
                                         POST DOWNSTREAM_URL (allowed items only)    │  ▲  JSON-RPC responses
                                         no client Authorization; adds x-gateway-role,│  │  (validated; failures
                                         x-request-id, x-forwarded-for                ▼  │   become -32003)
                                                                 ┌──────────────────────────────────────────┐
                                                                 │      Downstream MCP server :8081 /mcp    │
                                                                 │      (src/mock-downstream.ts for demos)  │
                                                                 └──────────────────────────────────────────┘
```

## Quick start

All commands run from this folder (`task2-mcp-gateway`). Dependencies are installed once from
the repository root with `npm install`.

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest: unit + end-to-end tests with real servers on ephemeral ports
npm run build       # tsc to dist/
```

### Run both servers locally

Terminal 1, the mock downstream MCP server on port 8081:

```bash
npx tsx src/mock-downstream.ts
```

Terminal 2, the gateway on port 8080:

```bash
export JWT_SECRET=dev-secret-change-me-0123456789
npx tsx src/index.ts
```

(After `npm run build` you can use `node dist/mock-downstream.js` and `node dist/index.js`.)

Every port can be overridden by environment variables in case the defaults are already in use
locally: `PORT=9081 npx tsx src/mock-downstream.ts` for the mock, and
`PORT=9080 DOWNSTREAM_URL=http://127.0.0.1:9081/mcp npx tsx src/index.ts` for the gateway (then
use `http://127.0.0.1:9080/mcp` and `http://127.0.0.1:9081/__requests` in the demo).

### Demo (copy and paste into a third terminal, in this folder)

```bash
export JWT_SECRET=dev-secret-change-me-0123456789
VIEWER=$(npx tsx src/index.ts --mint-token viewer)
ADMIN=$(npx tsx src/index.ts --mint-token admin --sub alice)
```

1. Viewer lists tools (forwarded transparently, HTTP 200):

```bash
curl -s http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $VIEWER" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_weather",...},{"name":"search_docs",...},{"name":"admin_reset_key",...},{"name":"admin_delete_user",...},{"name":"slow_tool",...}]}}
```

2. Viewer calls an admin tool (intercepted, HTTP 403, downstream never called):

```bash
curl -s -i http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $VIEWER" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"account":"acme"}}}'
```

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"Unauthorized Tool Call","data":{"tool":"admin_reset_key","requiredRole":"admin","role":"viewer","requestId":"12472797-..."}}}
```

3. Admin calls the same tool (forwarded, HTTP 200):

```bash
curl -s http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"account":"acme"}}}'
```

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Key for acme rotated. New key: sk-mock-ROTATED-KEY-0000-do-not-leak"}]}}
```

4. No token (HTTP 401, nothing forwarded, not even `tools/list`):

```bash
curl -s -i http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}'
```

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"Authentication required","data":{"requestId":"fdddeab0-...","reason":"missing_token"}}}
```

To see what actually reached the downstream (call 2 is absent):

```bash
curl -s http://127.0.0.1:8081/__requests
```

Without a JWT secret you can also demo with fixed tokens:
`STATIC_TOKENS="demo-admin:admin,demo-viewer:viewer" npx tsx src/index.ts`, then use
`-H "Authorization: Bearer demo-viewer"`.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Listen address. |
| `GATEWAY_PATH` | `/mcp` | The only path that accepts MCP traffic (others get 404). |
| `DOWNSTREAM_URL` | `http://127.0.0.1:8081/mcp` | Full URL of the downstream MCP endpoint. |
| `JWT_SECRET` | (none) | HS256 secret, at least 16 characters. Required unless `STATIC_TOKENS` is set. |
| `STATIC_TOKENS` | (none) | Demo token table, `token1:admin,token2:viewer`. |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Timeout for the whole downstream exchange (connect, headers, body). |
| `REQUEST_TIMEOUT_MS` | `30000` | Node's `server.requestTimeout`: a client must deliver its whole request within this time (slow-body defence). |
| `HEADERS_TIMEOUT_MS` | `10000` | Node's `server.headersTimeout`: a client must deliver its request headers within this time (slowloris defence); must not exceed `REQUEST_TIMEOUT_MS`. |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | Request body cap; larger bodies get 413. |
| `DOWNSTREAM_AUTH_HEADER` | (none) | Service credential sent as `Authorization` to the downstream, e.g. `Bearer svc-xyz`. |
| `CORS_ALLOWED_ORIGINS` | (none) | Comma-separated browser origins allowed by CORS (`*` for any). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr. |

The mock downstream reads `PORT` (default `8081`) and `HOST`.

## Architecture

### Modules

| File | Responsibility |
|---|---|
| `src/jsonrpc.ts` | JSON-RPC 2.0 types, strict guards (`isRequest`, `isNotification`, `isBatch`, `isResponse`) and error constructors. |
| `src/auth.ts` | `createAuthenticator()`: Bearer parsing, HS256 JWT verification, static token table; `signToken()`. |
| `src/policy.ts` | `authorize(message, role)`: a pure function over a data-driven rule table. |
| `src/gateway.ts` | `createGateway(opts)`: the HTTP pipeline, downstream forwarding, merging. |
| `src/config.ts` | Validated environment configuration. |
| `src/logger.ts` | JSON-lines logger on stderr with per-request child loggers. |
| `src/index.ts` | Entry point and `--mint-token` CLI. |
| `src/mock-downstream.ts` | Mock MCP server with a request log at `GET /__requests`. |

### Request pipeline

1. **Route and method.** Only `POST <GATEWAY_PATH>` carries MCP. `GET` gets 405 (this gateway
   offers no SSE stream), `OPTIONS` is the CORS preflight, other paths get 404.
   `GET /healthz` is an unauthenticated liveness probe.
2. **Origin and Content-Type.** A request with an `Origin` header that is not in
   `CORS_ALLOWED_ORIGINS` gets 403 (the MCP Streamable HTTP spec requires Origin validation to
   stop DNS-rebinding attacks from browsers). The media type must be `application/json`
   (a `charset` parameter is fine), otherwise 415.
3. **Authenticate.** The `Authorization: Bearer` token is verified before the body is read.
   Failure is 401 with -32002 and a `WWW-Authenticate` header. This is a deliberate fail-closed
   choice: an unauthenticated client gets nothing, including `tools/list`, and cannot make the
   gateway buffer or parse a body.
4. **Read and parse.** The body is read with a byte cap (`Content-Length` above the cap is
   refused immediately; a chunked body that grows past it is cut off and the socket destroyed).
   Invalid JSON is 400 with -32700 and `id: null`.
5. **Validate and authorize each item.** A single object is treated as a batch of one. Each item
   must be a valid Request or Notification (`jsonrpc: "2.0"`, string `method`, object/array
   `params`, string or number `id`; MCP forbids `null` ids); anything else is -32600 with
   `id: null`. Valid items go through `authorize()`, which denies admin tools for non-admins
   (-32001) and a `tools/call` without a non-empty string `params.name` (-32602 Invalid params,
   request id echoed: the envelope is valid, the method's parameters are not).
6. **Forward once.** All allowed items go downstream in one HTTP request, keeping the client's
   shape: a single object is forwarded as a single object, a batch as a batch of the allowed
   subset. Request headers come from an allow-list (`Accept`, `Mcp-Session-Id`,
   `MCP-Protocol-Version`); the client's `Authorization`, cookies and everything else are
   dropped, and the gateway adds `x-gateway-role`, `x-request-id`, `x-forwarded-for` and the
   optional `DOWNSTREAM_AUTH_HEADER`. The downstream exchange is bounded by
   `UPSTREAM_TIMEOUT_MS` (AbortController) and a 10 MiB response cap, and is aborted if the
   client disconnects. Redirects are not followed.
7. **Merge.** Local denials and downstream responses are put back in the client's order,
   matched by id (`1` and `"1"` are different ids; duplicate ids are matched in order).
   Notifications produce no entry. If nothing is left to answer, the response is 202 with an
   empty body (MCP Streamable HTTP convention). `Mcp-Session-Id` from the downstream is passed
   back to the client.

The gateway forwards the re-serialised object it inspected, not the client's raw bytes. That
removes parser-differential tricks such as `{"name":"get_weather","name":"admin_reset_key"}`:
the downstream sees exactly the one `name` the policy checked.

### Auth model

- **Primary: HS256 JWT** verified with `node:crypto` only. The header must be `alg: "HS256"`
  (checked first, so `alg: none` and algorithm-confusion tokens are rejected before any
  signature work; `crit` headers are refused). The signature is recomputed with HMAC-SHA256 and
  compared with `crypto.timingSafeEqual`, and non-canonical base64url signatures are refused.
  `exp` is required (tokens without expiry are rejected), `nbf` is checked when present, `role`
  must be `admin` or `viewer`, and `sub` becomes the subject used in audit logs.
- **Secondary: static token table** (`STATIC_TOKENS`) for demos and service accounts. Tokens are
  stored as SHA-256 digests so the lookup never compares secrets byte by byte.
- **Why the role must come from a verified token.** Anything in a plain header (`X-Role: admin`)
  is chosen by the client, so trusting it would let any caller promote itself. The role is
  only taken from a claim whose integrity the gateway checked with a secret it holds. The test
  suite sends `x-gateway-role: admin` without a token and expects 401.
- Tokens are never logged. Clients get only a coarse reason (`missing_token`, `invalid_token`,
  `expired_token`) so they know whether to refresh without learning which check failed.

### Authorization rules

`authorize(message, role, rules)` in `src/policy.ts` is a pure function. Rules are data:

```ts
export const DEFAULT_TOOL_RULES = [{ prefix: "admin_", roles: ["admin"] }];
```

| Message | viewer | admin |
|---|---|---|
| `tools/list`, `initialize`, `ping`, `notifications/*`, `resources/*`, `prompts/*`, any other method | forward | forward |
| `tools/call`, `params.name` = `get_weather`, `search_docs`, ... | forward | forward |
| `tools/call`, `params.name` starts with `admin_` | **deny -32001** | forward |
| `tools/call` without a non-empty string `params.name` | **deny -32602** | **deny -32602** |

- Prefixes match case-insensitively and ignoring surrounding whitespace, so `Admin_Reset_Key`
  cannot slip through if the downstream normalises names.
- Every matching rule must allow the role (the most restrictive rule wins). Adding
  `{ prefix: "billing_", roles: ["admin"] }` is the whole change for a new rule.
- Denied **notifications** (no `id`) are dropped and logged, never forwarded, and get no
  response, as JSON-RPC requires.
- The -32001 error carries `data: { tool, requiredRole, role, requestId }`.

### Error codes and HTTP status

| Situation | HTTP | JSON-RPC code | `id` |
|---|---|---|---|
| Body is not valid JSON | 400 | -32700 Parse error | `null` |
| Not a Request/Notification (`42`, `"x"`, missing or `"1.0"` `jsonrpc`, bad `params`), empty batch, batch over 100 items | 400 | -32600 Invalid Request | `null` |
| Request with `"id": null` (MCP requires a string or number id); inside a batch only that item is rejected | 400 (200 in a batch) | -32600 Invalid Request | `null` |
| `tools/call` without a non-empty string `params.name` | 400 | -32602 Invalid params | echoed |
| Missing, malformed, wrongly signed, `alg: none`, expired token | 401 | -32002 Authentication required | `null` |
| Role may not call the tool | 403 | -32001 Unauthorized Tool Call | echoed |
| Content-Type not `application/json` | 415 | -32600 | `null` |
| Body over `MAX_BODY_BYTES` | 413 | -32600 | `null` |
| `GET` / other HTTP methods on `/mcp` | 405 | -32600 | `null` |
| Origin not allowed | 403 | -32600 | `null` |
| Downstream unreachable, timed out, non-2xx, non-JSON, empty, SSE, oversized | 502 | -32003 Upstream unavailable | echoed per forwarded request |
| Downstream answered (result or its own JSON-RPC error) | 200 | as returned by downstream | as returned |

Why 403 for -32001 and not 200: JSON-RPC over HTTP often uses 200 for application errors, but
this one is an authorization decision made by an HTTP intermediary, and 403 lets load balancers,
dashboards and clients that only look at status codes see it. The JSON-RPC body is still the
source of truth. The status mapping applies to single (non-batch) messages answered by the
gateway; a batch is 200 (mixed outcomes) unless the downstream call failed, in which case it is
502.

Every gateway error includes `data.requestId`, the same value as the `x-request-id` response
header and the `requestId` field in the logs. Nothing from the downstream (connection errors,
status bodies, stack traces) is ever copied into a client response; it goes only to the stderr
log, keyed by that id.

### Batch semantics

- A batch is split per item: valid and allowed items are forwarded together as one downstream
  batch, denied and invalid items are answered by the gateway, notifications get no entry.
- The response array follows the client's order. Example: a viewer sends
  `[tools/list #1, admin_reset_key #2, notifications/initialized, get_weather #3]`, the
  downstream receives a batch of 3 messages (2 requests + 1 notification), and the client gets
  exactly 3 entries: `#1` result, `#2` -32001, `#3` result.
- If every item is a notification, or everything is denied notifications, the answer is 202 with
  an empty body. An empty batch `[]` is a single -32600 (not an array), per the spec.
- If the downstream fails, each forwarded request gets its own -32003 entry, local denials are
  kept, and the HTTP status is 502.
- A forwarded request the downstream did not answer becomes -32003 for that id; unsolicited
  downstream responses are dropped and logged.

### Testing

`npm test` starts the mock downstream and the gateway in-process on ephemeral ports and
exercises them over real HTTP. The mock records every request, and tests assert against
`GET /__requests` that denied calls never reached it. The mock's failure modes are selected per
URL (`?delay=<ms>`, `?mode=sse|text|500|empty`) plus a `slow_tool`. Coverage includes every case
in the task statement and the grading criteria: forwarding, `-32001` with no downstream call,
admin success, all token failure modes, static tokens, parse/invalid-request id rules, falsy ids
(`0`, `""`), `null` ids rejected, batches, 202 for notification-only batches, unreachable / slow / 500 / non-JSON /
SSE downstreams with no leaked upstream text, header stripping, session pass-through, 413, 405,
415, CORS, server timeouts and config validation. `policy.ts`, `auth.ts`, `jsonrpc.ts` and `config.ts` also have
direct unit tests.

## Known limitations

- **No SSE / streamable responses.** If the downstream answers with `text/event-stream`, the
  gateway logs `SSE not supported by this gateway` and returns 502 -32003; `GET /mcp` (the
  server-to-client stream) is 405. Adding it: pipe the downstream SSE stream through an
  incremental parser that splits on blank lines, parse each `data:` payload as JSON-RPC, pass
  responses through unchanged and apply `authorize()` to any server-initiated request (for
  example sampling) before writing the event to the client, with backpressure from
  `res.write()` and the same timeout/abort wiring. Client-sent JSON-RPC responses (answers to
  server-initiated requests) only exist with SSE, so they are rejected today as -32600.
- **Downstream non-2xx is always -32003.** That includes a 404 that an MCP server uses to say
  "session expired, re-initialize". A production version would pass that specific status
  through.
- **No rate limiting** or per-subject quotas.
- **Static role list** (`admin`, `viewer`) compiled in, and rules are code, not configuration.
- `tools/list` is forwarded unfiltered, so a viewer can see that admin tools exist (it just
  cannot call them).
- JSON numbers are re-serialised by `JSON.parse`/`JSON.stringify`, so integer ids above 2^53
  lose precision.
- HS256 means the gateway and the token issuer share a secret.

## What I would do in production

- **Tokens from an IdP:** RS256/ES256 JWTs verified against the IdP's JWKS (cached, rotated by
  `kid`), with `iss` and `aud` checks, short lifetimes and roles/scopes from standard claims,
  or OAuth 2.1 as the MCP authorization spec describes.
- **Per-tenant policy:** per-tool allow-lists per tenant and role loaded from a policy store (or
  OPA/Cedar), hot-reloaded, plus filtering `tools/list` so callers only see what they may call.
- **Audit log sink:** ship the `tool_call_denied` and request events (subject, role, tool,
  decision, request id) to an append-only store, not just stderr.
- **mTLS to the downstream** and a per-downstream service identity instead of a shared header.
- **OpenTelemetry** traces and metrics (decision counts, upstream latency, error rates) with
  `traceparent` propagation to the downstream.
- **Rate limits** per subject and per tool, and circuit breaking for an unhealthy downstream.
- **SSE support** as described above, and multiple downstreams routed by tool namespace.
