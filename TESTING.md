# TESTING.md — what was verified, and how

Last full run: 2026-11-08, Node 24.12, macOS. `npm run check` from the repo root exits 0.

## Automated (all pass)

| Task | Test files | Tests | What the tests prove |
|---|---|---|---|
| 1 `task1-mcp-server` | 5 | 52 | Real server spawned over stdio: every stdout line is JSON-RPC 2.0, logs are on stderr only, reason text never logged. 27 validation cases through the SDK client (`-32602` for every malformed field, unknown tool, missing params, array arguments). Malformed stdin lines (`{not json`, batches, `jsonrpc:"1.0"`, oversize lines, ids `0`/`""`/`null`) get `-32700`/`-32600`. Business failures (`isError`) stay tool-level. Source scan for stdout writes. |
| 2 `task2-mcp-gateway` | 5 | 82 | End-to-end against a real mock downstream on port 0: viewer `tools/list` forwarded, viewer `admin_*` call denied `-32001`/403 and never reaches downstream, admin call forwarded, no/invalid/expired/`alg:none` token → 401 `-32002`, parse errors, invalid envelopes, `id:null`, missing tool name `-32602`, batch split/merge in order (notifications forwarded, no response entries), notification-only batch → 202, downstream down/slow/SSE/non-JSON → 502 `-32003` with no upstream text, Authorization stripped and `x-gateway-role` added downstream, 413 on oversize and endless bodies, 405, 101-item batch → 400. Unit tests for JWT verification, policy, config. |
| 3 `task3-llm-guardrail` | 4 | 67 | Chunking-independence property test (random texts × random chunkings, 1-char to whole-text) `concat(push)+flush == redactText`; explicit split-boundary cases for email, SSN and card; false positives (phone, order numbers, non-Luhn 16 digits) untouched; held chars never exceed the cap; idle-flush orphan-tail protection; lone-surrogate regression; SSE parser across byte boundaries, CRLF, split UTF-8, `event:`-only blocks, 4 MB chunk linear-time; gateway end-to-end: TTFT before stream end, 3 redactions, `stream:false`, 400/415/405/413/502 paths with sanitized bodies, client abort propagates to provider, bounded heap on a 2 MB stream; OpenAI-compatible adapter against a mock SSE server; Anthropic event parsing against fixtures; request/headers timeouts set. |
| 4 `task4-model-router` | 3 | 86 | Sliding-window limiter: fill/deny, exact ageing, exact `retryAfterMs`, settle up/down, release, evict, `request_exceeds_limit`; 100 racing reservations admit exactly 50; two connections and 4 worker threads on one file never over-admit; state survives reopen. Router: ok, 429, timeout (short injected and real 3000 ms), 5xx, 401/403, network, bad JSON fail over; 400/404/422 do not; both fail → 503/504; late primary result ignored with exactly one settle and no dangling timers. Server: headers, gateway 429 with `Retry-After`, 401 before body read (`Connection: close`), 413, failover visible, error-sanitization sweep (forbidden-pattern regex over every failure body), 20 parallel requests against a budget for 10 → exactly 10 succeed and the SQLite window sum matches. |

Every suite was run at least 3 times in a row by the reviewers with no flaky test.
`scripts/check-duplicates.mjs`: no `console.log` in any `src/`, no duplicate test names.

## Manual / end-to-end (done by the reviewers on non-default ports, then torn down)
- Task 1: a 20-line stdin session (initialize, list, valid call, invalid id, broken JSON, unknown method, batch, `1e-9`, `__proto__`, array arguments, missing name/params, ids `0`/`""`/`null`, `0.005`, bare string). stdout carried only JSON-RPC, stderr only logs.
- Task 2: the README's four `curl` commands (viewer list 200, viewer admin call 403/-32001, admin call 200, no token 401/-32002) plus mixed-id batches, duplicate `name` keys, a 101-item batch, and a grep of the log for tokens (none).
- Task 3: streaming demo through the mock OpenAI-compatible upstream and through `PROVIDER=mock`, with per-chunk timestamps proving incremental delivery (first chunk ~100 ms, words 40–80 ms apart, email/SSN/card each `[REDACTED]`, phone and order number intact); `stream:false`; provider 401 → 502 with no key in the body; mid-stream provider death → SSE `event: error`; client disconnect closes the upstream connection.
- Task 4: the README's `curl` sequence (200 from primary, flip primary to 429 → secondary, hang → failover at ~3.0 s with the primary abort recorded, both down → 503 clean body, small tenant → 429 with `Retry-After: 60`, endless chunked body → 413).
- Benchmarks (Task 3, `npm run bench`): ~20 MB/s at 20-byte chunks, ~55 MB/s at 4 KB chunks, max held 30 chars, one-shot ~58 MB/s.

## Not verified
- **Real LLM providers.** Task 3's Anthropic and OpenAI adapters and Task 4's `HttpProvider` were tested only against mocks and fixtures; no real API key was used. The wire formats follow the public docs, but a live call has not been made.
- **Other Node versions.** Only Node 24.12 was used. `engines` says ≥ 20.19; `better-sqlite3` ships prebuilt binaries for Node 20–24.
- **Slowloris cut-off in real time.** `requestTimeout`/`headersTimeout` are asserted on the server object, not exercised with a 30-second dribbling client.
- **Default ports on this Mac.** 8081, 8082 and 8091 are occupied by other local dev servers here; the READMEs show how to override every port. Graders' machines will differ.
- **Nothing is committed.** The repo is initialized on `main` with no commits (held for your decision).
