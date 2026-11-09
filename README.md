# Solution Architect Assessment — MCP & LLM Gateway Tasks

Four standalone, runnable TypeScript/Node.js solutions, one per assessment task. Each folder has
its own README with run instructions, an architecture section and the trade-offs behind it.

| Task | Folder | What it is | Key design point |
|---|---|---|---|
| 1 | [`task1-mcp-server/`](task1-mcp-server/README.md) | MCP server over stdio with `get_customer_record` and `trigger_refund`, strict Zod validation | stdout is reserved for JSON-RPC and enforced at three layers; schema failures map to JSON-RPC `-32602`, business failures to tool `isError` results |
| 2 | [`task2-mcp-gateway/`](task2-mcp-gateway/README.md) | HTTP/JSON-RPC reverse proxy with Bearer-token roles and per-tool authorization | Role comes from a verified HS256 JWT, `admin_*` tools need `admin`, denied calls answered locally with `-32001`, batches split and merged in order |
| 3 | [`task3-llm-guardrail/`](task3-llm-guardrail/README.md) | Streaming LLM proxy that redacts emails, SSNs and card numbers in flight | Pattern-aware hold-back buffer: only the tail that could still start a match is held (capped), so TTFT and memory stay bounded |
| 4 | [`task4-model-router/`](task4-model-router/README.md) | Token-aware sliding-window rate limiter plus primary→secondary model failover, on-disk SQLite | Reserve-then-settle token accounting in `IMMEDIATE` transactions, 3000 ms timeout race with cleanup, one sanitized error payload shape |

## Requirements
- Node 24 (see `.nvmrc`); Node 20.19+ should also work.
- `npm install` once at the repo root (npm workspaces). Tasks share only `node_modules`; no task imports another.

## Run everything
```bash
npm install
npm run check      # typecheck + tests + build for all four tasks, then repo hygiene checks
```
Per task: `cd task1-mcp-server && npm test` (same for the others). Each README has a live demo
with `curl`.

## Conventions
See [`AGENTS.md`](AGENTS.md) for the stack, the design bar and the known gotchas. Decisions made
without asking are in [`DECISIONS.md`](DECISIONS.md); verification status is in
[`TESTING.md`](TESTING.md).

## Dependency policy
Only what the assessment names: `@modelcontextprotocol/sdk` and `zod` for Task 1,
`better-sqlite3` for Task 4. Tasks 2 and 3 use Node built-ins only (`node:http`, `fetch`,
`node:crypto`, Web Streams), because a proxy and a stream guardrail are easier to grade, and to
reason about, without a framework between the code and the wire.
