# Task 1: MCP server over stdio (get_customer_record, trigger_refund)

A runnable Model Context Protocol server built on the official `@modelcontextprotocol/sdk` (1.32) with strict
Zod 4 validation. It talks JSON-RPC 2.0 over **stdio**; stdout carries protocol frames only, all logs go to stderr.

## Run it

```bash
npm install                 # once, from the repo root (npm workspaces)
cd task1-mcp-server
npm run dev                 # tsx src/index.ts (waits for JSON-RPC on stdin)
npm run build && npm start  # tsc to dist/, then node dist/index.js
npm test                    # vitest (52 tests)
npm run typecheck
```

Env vars: `LOG_LEVEL` (debug|info|warn|error, default info), `MAX_REFUND_AMOUNT` (default 10000).

## Connect from an MCP client

Inspector (from this folder, after `npm run build`):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Claude Desktop, `claude_desktop_config.json` (use an absolute path):

```json
{
  "mcpServers": {
    "customer-refunds": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-gateway-assessment/task1-mcp-server/dist/index.js"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

## Example session (newline-delimited JSON on stdin/stdout)

Paste into `node dist/index.js` (responses shown as they appear on stdout; key order may differ).

```jsonc
// -> initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
// <-
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"task1-mcp-server","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
// -> notification (no response)
{"jsonrpc":"2.0","method":"notifications/initialized"}
// -> tools/list
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
// <- both tools with inputSchema, outputSchema and annotations
// -> valid call
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-00001"}}}
// <-
{"result":{"content":[{"type":"text","text":"{\"customer_id\":\"CUST-00001\",\"name\":\"Ada Lovelace\",\"email\":\"ada@example.com\",\"balance\":250,\"refunds\":[]}"}],"structuredContent":{"customer_id":"CUST-00001","name":"Ada Lovelace","email":"ada@example.com","balance":250,"refunds":[]}},"jsonrpc":"2.0","id":3}
// -> invalid call (4 digits)
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-1234"}}}
// <- JSON-RPC protocol error
{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"MCP error -32602: Invalid arguments for tool get_customer_record: customer_id: customer_id must match CUST-XXXXX (exactly five digits)"}}
```

Seeded customers: `CUST-00001` to `CUST-00005` (`CUST-00004` has balance 0, handy for the over-balance case).

## Validation rules

| Field | Rule | Notes |
|---|---|---|
| `customer_id` | `^CUST-\d{5}$` | **Interpretation:** `XXXXX` = exactly five digits. One constant, `CUSTOMER_ID_PATTERN` in `src/schemas.ts`. No trimming or case folding: ` CUST-12345`, `cust-12345`, trailing newline all fail. |
| `amount` | number, `>= 0.01`, finite | Strings (`"10"`), `null`, NaN, Infinity rejected. |
| `amount` | at most 2 decimal places | Policy: it is money. `10.123` rejected. |
| `amount` | `<= MAX_REFUND_AMOUNT` (default 10000) | Policy: a per-call ceiling limits blast radius; override via env. |
| `reason` | string, trimmed, 10 to 500 chars | Trim first, so 9 characters padded with spaces fail. The max stops log/storage abuse. |
| any object | `.strict()` | Unknown fields are rejected, not dropped. |

## Protocol errors vs tool errors

| Failure | Surface | Why |
|---|---|---|
| Malformed arguments (bad format, wrong type, missing/extra field, out-of-policy amount/reason) | JSON-RPC error `-32602` Invalid params | The request itself is invalid; a client bug, not a business outcome. |
| Unknown tool name | JSON-RPC error `-32602` | Same code the SDK uses for unknown tools. |
| Unknown method | `-32601` (SDK) | Standard. |
| Unparseable JSON | `-32700`, `id: null` | Answered by `src/stdin-guard.ts`; the SDK transport would drop the line silently. |
| Bad envelope (`jsonrpc` not `"2.0"`, `id: null`, non-string method), batch array, line over 1 MiB | `-32600`, `id` echoed when recoverable, else `null` | Same guard. MCP 2025-06-18 removed batches. |
| Malformed `tools/call` params (no `name`, `arguments` not an object) | `-32602` | Checked by the dispatcher; the SDK schema would return `-32603` with a raw Zod dump. |
| Unknown customer, refund exceeds balance | Result with `isError: true` and a text message | A valid request that failed in business logic; the model should see it and react. |

One deliberate deviation from the SDK default: SDK 1.32's built-in `tools/call` handler catches its own
`McpError(-32602)` and turns it into an `isError` tool result, so a malformed call would look like an ordinary
tool failure. `src/server.ts` therefore keeps `registerTool` for metadata (`tools/list`, annotations, schemas)
but replaces the `tools/call` handler with a small dispatcher that validates with the same strict Zod schemas
and throws `McpError(InvalidParams)`, which the SDK serialises as a real JSON-RPC error. Error messages list
field paths and rules only, never stack traces or input values.

## stdout / stderr discipline (three layers)

1. **Console redirect.** `src/index.ts` first replaces `console.log/info/debug` with a stderr writer, then
   dynamically imports everything else, so even a dependency calling `console.log` cannot corrupt stdout.
2. **Logger to stderr.** `src/logger.ts` writes JSON lines to `process.stderr` only. Tool calls log start,
   finish and duration with redacted args (`reason` is logged as its length only).
3. **Tests.** `test/stdio-isolation.test.ts` spawns the real server (`LOG_LEVEL=debug`), runs a full handshake
   plus valid, invalid and business-error calls, and asserts every stdout line is a JSON-RPC 2.0 message and
   that logs appear on stderr (and that reason text does not). `test/no-stdout-in-src.test.ts` fails if
   `console.log(` or `process.stdout.write(` appears anywhere in `src/`.

## Layout

`src/index.ts` entry and signal handling; `src/stdin-guard.ts` answers malformed stdin lines; `src/server.ts` tool registration and dispatch; `src/schemas.ts`
Zod schemas and policy constants; `src/customers.ts` pure in-memory repository (injectable clock and id
generator); `src/logger.ts`. Tests: `validation` (in-memory `Client`), `stdio-isolation`, `stdin-guard`, `customers`,
`no-stdout-in-src`.

## What I would do in production

- Real datastore with transactions; refunds as a ledger with row-level locking rather than a mutable balance.
- Idempotency keys on `trigger_refund` (client-supplied key, unique constraint) so retries cannot double-refund; the current `refund_id` is only a generated receipt.
- Authentication and authorization at the MCP gateway (per-caller scopes, per-tool and per-amount limits, human approval above a threshold), not inside the tool.
- Immutable audit log (who, what, when, request id) shipped from stderr to a log pipeline; PII minimisation in logs.
- Rate limiting, request size caps, and a request id returned in every error for support correlation.
- Streamable HTTP transport behind the gateway for multi-tenant use; stdio stays for local clients.
