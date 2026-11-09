# AGENTS.md — conventions for anyone (or any coding agent) working in this repo

This repository answers a four-task Solution Architect assessment (MCP servers, MCP gateways,
LLM gateways, security guardrails). Each task lives in its own workspace and must be
**runnable and gradable on its own**: a grader will `cd` into one task folder, read its README,
run `npm test`, and run the server. Never make one task import from another.

## Stack (pinned; do not change versions or add dependencies casually)
- Node 24 (`.nvmrc`), TypeScript 5.9 strict (`tsconfig.base.json`), ESM (`"type": "module"`).
  Local imports therefore need the `.js` extension: `import { x } from "./foo.js"`.
- Tests: vitest 4 (`test/**/*.test.ts`), run with `npm test` in the task folder.
- Run TS directly with `tsx` (`npm run dev`); production build is `tsc` to `dist/`.
- HTTP: Node's built-in `node:http` and the global `fetch` (undici). No Express/Fastify.
- Task 1 only: `@modelcontextprotocol/sdk` 1.32 + `zod` 4. Task 4 only: `better-sqlite3` 12.
- Logging: a tiny `logger.ts` per task that writes structured JSON lines to **stderr**.
  `console.log` is banned in all `src/` folders (a duplicate/lint script enforces this).

## The checks every task must pass
```
npm run typecheck   # tsc --noEmit, strict, noUnusedLocals
npm test            # vitest run
npm run build       # tsc to dist/
```
From the repo root, `npm run check` runs all of the above for every workspace plus
`scripts/check-duplicates.mjs` (banned console.log in src, duplicate file basenames across tasks
that are not in the allow-list, and duplicate test names).

## Design bar (graders score these)
- **Protocol correctness first.** JSON-RPC 2.0 wire format exactly: `jsonrpc: "2.0"`, `id`
  echoed (including `null` where the spec says), notifications (no `id`) get no response,
  batches (arrays) are supported where the task touches raw JSON-RPC.
  Standard codes: -32700 parse error, -32600 invalid request, -32601 method not found,
  -32602 invalid params, -32603 internal error, -32000..-32099 server-defined.
- **Fail closed.** Anything the gateway cannot classify as safe is rejected, never forwarded.
- **No secrets or internals leak** in error responses: no stack traces, no upstream bodies,
  no file paths. Log them to stderr with a request id, return the request id to the caller.
- **Bounded memory.** Streams are processed incrementally; buffers have explicit caps.
- **Deterministic tests.** Inject clocks and random sources; use ephemeral ports (`listen(0)`);
  never `sleep` to wait for a server, await its `listening` event.
- **Small, readable modules** with a one-paragraph header comment explaining the design choice.
  Graders read code; prefer a clear 40-line function over a clever 10-line one.

## Each task folder must contain
- `README.md`: what it does, how to run it, how to test it, an architecture section explaining
  the key design decisions and trade-offs in plain language, and a "what I would do in
  production" section. Include copy-pasteable example `curl` or JSON-RPC exchanges.
- `src/index.ts`: the runnable entry point (reads config from env vars with safe defaults).
- `test/`: vitest tests covering the happy path, every validation/authorization edge in the
  task statement, and the failure modes graders list under "Evaluation Criteria".

## Gotchas already known
- ESM + `tsx`: `__dirname` does not exist; use `new URL(".", import.meta.url)` or
  `fileURLToPath`.
- `exactOptionalPropertyTypes` is on: don't assign `undefined` to an optional property; omit it.
- `noUncheckedIndexedAccess` is on: array/record lookups are `T | undefined`.
- vitest runs test files in parallel workers: every test starts its own servers on port 0 and
  uses its own temp dir/db file (`fs.mkdtempSync(path.join(os.tmpdir(), "..."))`).
- `fetch` keeps sockets alive; close servers with `server.closeAllConnections()` then
  `server.close()` in `afterAll`, or tests hang.
- Zod 4: `z.string().regex()`, `z.number().positive()`, `z.string().min(10)`; error details live in
  `error.issues`. The MCP SDK accepts Zod 4 schemas directly in `registerTool`.
- `@modelcontextprotocol/sdk` 1.32: import from deep paths, e.g.
  `@modelcontextprotocol/sdk/server/mcp.js`, `@modelcontextprotocol/sdk/server/stdio.js`,
  `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/types.js`.
  Read `node_modules/@modelcontextprotocol/sdk/README.md` for the current API before coding.
- better-sqlite3 is synchronous; wrap check-and-reserve in `db.transaction(...)` and open with
  `pragma journal_mode = WAL` and `busy_timeout`.

## Working in parallel
When several people or agents work at once, each owns a disjoint set of files; shared contracts
(this file, `tsconfig.base.json`, each `package.json`) change only by agreement. Record design
choices in `DECISIONS.md`.
