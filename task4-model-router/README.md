# Task 4: Resilient model router with a token-aware rate limiter

This is an LLM gateway endpoint, `POST /v1/completions`. It authenticates each tenant API key, admits
the request against a **sliding window of 50,000 tokens per minute** (configurable per tenant) kept
in **on-disk SQLite**, and sends the request to a **primary** model provider. If the primary returns
**429** or does not finish within **3000 ms**, the gateway **fails over** to a **secondary**
provider. Every failure goes back to the client as one **standard error payload** that never
includes upstream bodies, stack traces, file paths or driver messages. Those details go to the
stderr log under the same request id.

Stack: Node 24, TypeScript (strict, ESM), `node:http`, global `fetch`, `better-sqlite3` 12, vitest.

## Run it

You need three things running: the mock providers, the seed step (run once), and the gateway.

1. In the first terminal, start two mock OpenAI-compatible providers. The primary listens on 8091
   and the secondary on 8092.
   ```bash
   cd task4-model-router
   npm run dev:providers
   ```
2. In a second terminal, seed the demo tenants (run once), then start the gateway on port 8084.
   ```bash
   cd task4-model-router
   npx tsx src/index.ts --seed
   npm run dev
   ```
   The seed step creates two tenants. Only the SHA-256 hash of each key goes into the database.

   | API key | tenant | tokens/minute |
   |---|---|---|
   | `demo-key-123` | `tenant-demo` | 50,000 |
   | `small-key-456` | `tenant-small` | 1,000 |

   Every port can be overridden by environment variables in case the defaults are already in use
   locally: `PRIMARY_MOCK_PORT=9091 SECONDARY_MOCK_PORT=9092 npm run dev:providers` for the mocks
   and `PORT=9084 PRIMARY_URL=http://127.0.0.1:9091/v1 SECONDARY_URL=http://127.0.0.1:9092/v1 npm run dev`
   for the gateway (then use those ports in the requests below).

3. In a third terminal, try the requests below.

**A normal request.** The primary answers, and the response carries rate-limit headers:
```bash
curl -i localhost:8084/v1/completions \
  -H 'authorization: Bearer demo-key-123' -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","prompt":"Say hello","max_tokens":64}'
```
```
HTTP/1.1 200 OK
x-request-id: 567d113a-e673-4fd8-9721-7a3921db5846
x-ratelimit-limit: 50000
x-ratelimit-remaining: 49970
x-ratelimit-reset-ms: 59991

{"id":"567d113a-…","model":"primary-model","provider":"primary","text":"hello from primary",
 "usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30},"failed_over":false}
```

**Failover on 429.** Set the primary mock to return 429, then send the same request again:
```bash
curl -X POST localhost:8091/__behaviour -d '{"kind":"rateLimit","retryAfterSec":30}'
curl localhost:8084/v1/completions \
  -H 'authorization: Bearer demo-key-123' -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","prompt":"Say hello","max_tokens":64}'
```
```json
{"id":"40493d64-…","model":"secondary-model","provider":"secondary","text":"hello from secondary",
 "usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30},"failed_over":true}
```

**Failover on timeout.** Make the primary hang for 10 s. The request comes back from the secondary
after about 3.0 s, and the primary's socket is cancelled:
```bash
curl -X POST localhost:8091/__behaviour -d '{"kind":"hang","ms":10000}'
time curl localhost:8084/v1/completions -H 'authorization: Bearer demo-key-123' \
  -d '{"model":"gpt-4o-mini","prompt":"Say hello"}'
```

**Both providers down.** You get the standard error payload. The mock's error body contains a fake
stack trace and file paths, and none of it reaches the client:
```bash
curl -X POST localhost:8091/__behaviour -d '{"kind":"serverError"}'
curl -X POST localhost:8092/__behaviour -d '{"kind":"serverError"}'
curl -i localhost:8084/v1/completions -H 'authorization: Bearer demo-key-123' \
  -d '{"model":"gpt-4o-mini","prompt":"Say hello"}'
```
```
HTTP/1.1 503 Service Unavailable
x-request-id: 1130561b-9286-45c5-966a-d1e19c39a77b

{"error":{"code":"all_providers_failed","type":"upstream_unavailable",
 "message":"All model providers are currently unavailable. Please retry later.",
 "request_id":"1130561b-9286-45c5-966a-d1e19c39a77b","retryable":true}}
```

**Gateway rate limit (429 with `Retry-After`).** Put both mocks back to normal and have them report
950 completion tokens. Then spend most of the 1,000-token budget of `small-key-456`:
```bash
curl -X POST localhost:8091/__behaviour -d '{"kind":"ok","completionTokens":950}'
curl -X POST localhost:8092/__behaviour -d '{"kind":"ok"}'
curl -i localhost:8084/v1/completions -H 'authorization: Bearer small-key-456' \
  -d '{"model":"m","prompt":"hi","max_tokens":960}'
curl -i localhost:8084/v1/completions -H 'authorization: Bearer small-key-456' \
  -d '{"model":"m","prompt":"hi","max_tokens":200}'
```
The second call returns `HTTP/1.1 429`, `Retry-After: 60` (whole seconds, rounded up) and
`x-ratelimit-remaining: 40`, with this body:
```json
{"error":{"code":"token_rate_limit_exceeded","type":"rate_limited",
 "message":"Token rate limit exceeded for this API key.","request_id":"…","retryable":true,
 "retry_after_ms":59987}}
```

Other useful calls:
```bash
curl localhost:8084/healthz                                  # {"status":"ok","db":"ok"}
curl -X POST localhost:8091/__behaviour -d '{"kind":"ok"}'   # put the primary back to normal
curl localhost:8091/__requests                               # {"count":N,"aborted":M}
```
The mock behaviours are `ok` (optional `text`, `promptTokens`, `completionTokens`, `delayMs`),
`rateLimit` (`retryAfterSec`), `hang` (`ms`), `slowBody` (`ms`: sends the headers, then stalls the
body), `serverError` (`status`), `badJson` and `clientError` (`status`).

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8084` | Gateway port |
| `HOST` | `127.0.0.1` | Interface the gateway binds (loopback by default, because the demo keys are public; use `0.0.0.0` to expose it) |
| `DB_PATH` | `./data/gateway.db` | SQLite file (the folder is created if missing) |
| `PRIMARY_URL` / `PRIMARY_KEY` / `PRIMARY_MODEL` | `http://127.0.0.1:8091/v1` / mock key / `primary-model` | Primary OpenAI-compatible provider |
| `SECONDARY_URL` / `SECONDARY_KEY` / `SECONDARY_MODEL` | `http://127.0.0.1:8092/v1` / mock key / `secondary-model` | Backup provider |
| `UPSTREAM_TIMEOUT_MS` | `3000` | Deadline for each provider attempt |
| `REQUEST_TIMEOUT_MS` | `30000` | Node's `server.requestTimeout`: a client must deliver its whole request within this time (slow-body defence) |
| `HEADERS_TIMEOUT_MS` | `10000` | Node's `server.headersTimeout`: a client must deliver its headers within this time (slowloris defence); must not exceed `REQUEST_TIMEOUT_MS` |
| `EVICT_INTERVAL_MS` | `30000` | How often old usage rows are deleted |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `PRIMARY_MOCK_PORT` / `SECONDARY_MOCK_PORT` | `8091` / `8092` | Ports for `npm run dev:providers` |

## Test it

```bash
cd task4-model-router
npm run typecheck && npm test && npm run build
```
There are 86 tests. Each test file uses its own temp-dir SQLite file, servers on ephemeral ports,
and injected clocks.
- `test/rate-limiter.test.ts`
  - Fills the window to the limit, then denies.
  - Sliding behaviour to the millisecond: an event leaves the window exactly 60,000 ms after it
    was recorded.
  - Exact `retryAfterMs`.
  - Settle lower or higher than the reservation, settle-once, release, eviction (on a timer and
    opportunistic), and the `request_exceeds_limit` reason.
  - Exactly 50 of 100 reservations admitted, both in a synchronous loop and with `Promise.all`.
  - The budget survives a database close and reopen.
  - Two connections never over-admit, and neither do **4 worker threads with separate connections
    racing on one file**.
- `test/router.test.ts`
  - The `shouldFailover` policy table.
  - Primary ok, 429, hang (the mock sees the abort), stalled body, 500, bad JSON, 401 and 403
    (fail over with reason `auth_error`), 400 and 404 (no failover), both failed, both 401/403
    (503), both timed out, ECONNREFUSED.
  - A real 3000 ms default-timeout test.
  - Fake-timer race tests: a primary that resolves at 3100 ms after the 3000 ms timeout is
    ignored, the secondary answers at 3500 ms, `settle` is called **exactly once** with the
    secondary's usage, and `vi.getTimerCount() === 0` afterwards.
  - No unhandled rejection from a late loser.
  - A malformed upstream body is logged as length and content type only.
  - A database failure after a successful call still returns the completion.
- `test/server.test.ts`
  - End to end over HTTP with the real SQLite file: success headers, gateway 429 with
    `Retry-After`, 413, 401, 400s, 404 and 405 (with an `Allow` header).
  - The order size cap, then key, then body: an unauthenticated client gets its 401 while its
    body is still in flight, and Node's request and header timeouts are set.
  - Failover visible as `failed_over: true` (primary 429, and primary 401).
  - **Sanitisation over every scenario** (500, bad JSON, 429 then 503, timeouts, upstream 400 and
    422, both 401/403, ECONNREFUSED, a broken database). Each body is checked against
    `/at .*\.ts|node:internal|\/Users\/|ECONNREFUSED|better-sqlite3|sqlite/`, and the test checks
    that the details did reach the log.
  - Logs never contain API keys or prompt text.
  - **20 parallel requests with a budget for 10**: exactly 10 get 200, exactly 10 get 429, and
    the SQLite window sum equals the settled usage of the 10.

## Architecture

```
client ──POST /v1/completions──▶ server.ts (node:http)
                                   │ request id, route + method (404 / 405),
                                   │ declared Content-Length over 1 MiB → 413, Bearer key
                                   ▼
                                 pipeline.ts
                                   │ 1. auth: sha256(key) → tenants            → 401 (body never read)
                                   │ 2. read body (1 MiB cap), parse, validate → 400 / 413
                                   │ 3. limiter.tryReserve(estimate)  [SQLite BEGIN IMMEDIATE]
                                   │       window full → 429 + Retry-After
                                   │       request > limit → 413
                                   │ 4. router.route(req)
                                   │       ├─ primary  (AbortController + 3000 ms timer)
                                   │       │     429 / timeout / 5xx / network / bad JSON
                                   │       └─ secondary (own controller + fresh 3000 ms timer)
                                   │ 5. success → limiter.settle(actual usage)
                                   │    failure → limiter.release()  (exactly one of the two)
                                   │ 6. request_log row
                                   ▼
                     200 {id, model, provider, text, usage, failed_over}
                     or {error:{code,type,message,request_id,retryable,retry_after_ms?}}
```

| File | Role |
|---|---|
| `src/db.ts` | Opens SQLite (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), runs idempotent migrations, seeds tenants, looks tenants up by key hash, writes the request log |
| `src/tokens.ts` | Token estimate (characters / 4) and the reservation size |
| `src/rate-limiter.ts` | Sliding-window limiter: `tryReserve`, `settle`, `release`, `evict`, `status` |
| `src/providers.ts` | `ModelProvider` interface, `HttpProvider` (OpenAI-compatible), typed upstream errors |
| `src/router.ts` | Timeout race, failover policy (`shouldFailover`), mapping to gateway errors |
| `src/errors.ts` | `GatewayError`, the type to status table, `sanitize()` |
| `src/pipeline.ts` | Auth, validation, reserve, route, settle or release, request log (no HTTP) |
| `src/server.ts` | HTTP routing, body cap, the single error path |
| `src/logger.ts` | JSON lines on stderr, with redaction |
| `src/mock-providers.ts` | Controllable mock providers |
| `src/index.ts`, `src/config.ts` | Wiring, environment config, `--seed`, eviction timer, graceful shutdown |

### Rate limiter design

**Why a true sliding window over events.** Each admitted request writes one row:
`(tenant_id, ts_ms, tokens, state, request_id)`. The usage at time *now* is
`SUM(tokens) WHERE tenant_id = ? AND ts_ms > now − 60 000`. We compared three designs:
- **Fixed one-minute buckets** are cheap, but they allow 2× the limit across a bucket boundary
  (50k at 12:00:59 and another 50k at 12:01:00).
- **A token bucket** smooths bursts, but it answers a different question ("refill rate") from the
  one the task asks ("at most 50,000 tokens in any minute"), and its state is one number that
  cannot be settled after the fact.
- **The event log** answers the question exactly. It lets one request's charge be corrected later,
  and it gives an exact `retry_after`. That is why we chose it.

**Reserve, then settle.** We cannot know the token count before the call. Admission therefore
reserves a pessimistic estimate: `ceil(prompt chars / 4) + max_tokens` (256 if `max_tokens` is
absent). After the call, `settle` rewrites the row to the provider's real
`prompt_tokens + completion_tokens`, which can be lower or higher than the estimate, and marks it
`settled`. Some rules:
- Settle only touches `reserved` rows, so a second settle is a no-op and nothing is counted twice.
- If no completion was produced (every provider failed, or the upstream rejected the request), `release`
  deletes the reservation.
- A 429 from the primary followed by success on the secondary settles **once**, with the
  secondary's usage.
- A request that needs more than the whole limit is refused immediately with `413
  request_exceeds_token_limit`, rather than a `Retry-After` that could never be honoured.

**Atomic check-and-reserve.** The SUM and the INSERT run in one `db.transaction(...).immediate()`.
- Inside one process, better-sqlite3 is synchronous, so the event loop cannot run any other
  request's code between the check and the insert. Concurrent requests are serialised by
  construction.
- Across processes, `BEGIN IMMEDIATE` takes SQLite's write lock before the SUM, so a second
  process waits (up to `busy_timeout`) instead of reading a stale total.
- The tests check both cases: 100 racing reservations, two connections, and four worker threads
  with their own connections. None of them ever admit more than the limit.

**Exact `retry_after`.** When a request does not fit, the limiter walks the window's events oldest
first and adds up their tokens until the total covers the shortfall. That event's exit time
(`ts + 60 000`) is the earliest moment the request fits. This is exact for the current state. It
can only get later if more usage arrives first, or earlier if pending reservations settle lower.

**Eviction.** The window query never depends on eviction for correctness, because it filters on
`ts_ms`. Eviction only keeps the table small. `evict()` deletes rows with
`ts_ms <= now − window`. It runs every 100 reservations and on an unref'd 30 s timer, so the
timer never keeps the process alive by itself.

**Persistence.** This is why the data lives in SQLite on disk rather than in memory. A gateway
restart or crash does not give a tenant a fresh budget: the window is rebuilt from the file (a
test closes and reopens the database to prove it). The same file can also be shared by several
gateway processes on one host.

**Cost and scaling.**
- Each check is an indexed range SUM over the tenant's events in the last minute, so it costs
  O(events in window). On a denial, it also walks those events to find the retry time.
- That is fine at hundreds of requests per tenant per minute. At larger scale:
  - **Per-tenant summary rows.** Keep per-second sub-buckets (60 rows per tenant) that are
    incremented in the same transaction. The SUM then becomes O(60), with second-level accuracy.
  - **Redis sorted sets** for a multi-host fleet. Use `ZADD tenant ts:id tokens` and
    `ZREMRANGEBYSCORE` for eviction, with the check and the insert in one Lua script so they stay
    atomic across hosts. SQLite file locks only cover one host.

### Failover policy

| Primary outcome | Fails over? | Why |
|---|---|---|
| 429 Too Many Requests | yes | Required. It is the primary's capacity, not the request. We do not retry the primary. |
| No complete response within 3000 ms (connect, headers **and** body) | yes | Required. The primary's socket is aborted. |
| 5xx, 408 | yes | A safe superset of the statement: a server-side fault the backup may not share |
| Network error (ECONNREFUSED, reset, DNS) | yes | The primary is unreachable |
| 200 with malformed or non-JSON body, or an unexpected shape | yes | A broken primary; the backup may be fine |
| 401 Unauthorized, 403 Forbidden | yes (reason `auth_error`) | The gateway's own credential or entitlement for that provider is broken (an expired key, a revoked model entitlement), not the client's request. The backup has its own credential, so it can serve the request. |
| 400, 404, 413, 422 and other 4xx | **no** → `502 upstream_rejected` | The request itself is the problem and would fail the same way on the backup, wasting latency and budget |

The policy is one small predicate, `shouldFailover(err)` in `src/router.ts`, and it has its own
table of unit tests. If the secondary also fails, the client gets one error:
- `upstream_timeout` (504) only when **both** attempts timed out.
- `upstream_rejected` (502) when the secondary returned a 4xx other than 401/403.
- `upstream_unavailable` (503, retryable) otherwise. This includes both providers failing with
  401/403: that is our credential problem, so the client is told to retry later and the body
  says nothing about upstream credentials.
- `retry_after_ms` is included only if every provider returned 429 with a `Retry-After` (the
  smallest value is used).

### The timeout race

- **One controller and one timer per attempt.** The provider call runs with
  `AbortController.signal`, and it is raced with `Promise.race` against a `setTimeout` deadline.
  The secondary gets a fresh controller and a fresh deadline, so the worst case is about
  2 × timeout.
- **The timeout covers the whole call.** The same signal goes to `fetch`, which also aborts the
  body stream. A provider that sends headers at once and then stalls the body still times out
  (the `slowBody` test).
- **Releasing the socket.** When the deadline wins, the controller is aborted. undici then destroys
  the connection, so a hung primary does not hold a socket or a slot. The mock records the abort
  and the tests assert it.
- **No dangling timers.** `clearTimeout` runs in `finally` on every path. The fake-timer tests
  assert that `vi.getTimerCount() === 0`. The controller is also aborted in `finally`, so nothing
  started by a finished attempt keeps running.
- **Late winners are ignored.** Once `Promise.race` has settled, a primary that answers at 3100 ms
  cannot change the result. The loser's promise has a `.catch` attached up front, so a late
  rejection never becomes an `unhandledRejection`. Only the pipeline calls `settle`, and it calls
  it once, with the value `route()` returned. So a late primary result can never be charged as
  well.

### Error contract

Every error has this shape, and nothing else is ever added to it:
```json
{ "error": { "code": "all_providers_failed", "type": "upstream_unavailable",
  "message": "All model providers are currently unavailable. Please retry later.",
  "request_id": "1130561b-9286-45c5-966a-d1e19c39a77b", "retryable": true } }
```
- `type` sets the HTTP status.
- `code` is a stable snake_case value that is more specific than `type`.
- `message` is a fixed sentence written in `errors.ts` or by our own validator. It is never
  upstream text.
- `request_id` matches the `x-request-id` header and the log lines.

| type | HTTP | retryable | example codes |
|---|---|---|---|
| `invalid_request` | 400 | no | `invalid_json`, `invalid_body`, `invalid_model`, `invalid_prompt`, `invalid_max_tokens`, `unknown_field` |
| `unauthorized` | 401 | no | `missing_api_key`, `invalid_api_key` |
| `not_found` | 404 | no | `not_found` |
| `method_not_allowed` | 405 | no | `method_not_allowed` |
| `request_too_large` | 413 | no | `body_too_large`, `prompt_too_large`, `request_exceeds_token_limit` |
| `rate_limited` | 429 | yes | `token_rate_limit_exceeded` (plus a `Retry-After` header in whole seconds, rounded up, and `retry_after_ms`) |
| `internal` | 500 | yes | `internal`: anything unexpected, via `sanitize()` |
| `upstream_rejected` | 502 | no | `upstream_rejected`: the provider refused the request (4xx other than 401/403) |
| `upstream_unavailable` | 503 | yes | `all_providers_failed` |
| `upstream_timeout` | 504 | yes | `all_providers_timed_out` |

How this is enforced:
- `HttpProvider` never puts an upstream body in `Error.message`. It puts it on `.internal`.
- The router keeps both attempts' errors on `GatewayError.internal`.
- `sanitize()` turns any non-`GatewayError` (a bug, or a SQLite exception) into `internal` with
  the message "An internal error occurred."
- `server.ts` has a single error path, and it only ever serialises `toPayload()`.

**What is logged vs returned.**
- **Returned:** only the payload above, plus `x-request-id` and, where relevant, `Retry-After` and
  `x-ratelimit-*`.
- **Logged** (JSON lines on stderr): the request id, tenant id, provider attempts with outcome,
  status and latency, the failover reason, and for failures the full error chain with stacks,
  upstream status, a capped snippet of the upstream body (2 KB) and causes such as ECONNREFUSED.
- **Never logged:** tenant API keys, upstream API keys, or prompt and completion text. The logger
  also redacts fields named like `api_key`, `authorization`, `prompt` or `text` as a second line of
  defence.
- **`request_log` table:** one row per request (tenant, requested model, provider used, status,
  latency, token counts, error type) for usage reporting.

### Other decisions

- **Authentication before the body is read.** The order is route, method, declared size cap, API
  key, body read (with the same byte cap), JSON parse, validation. An unauthenticated caller only
  ever learns "401", and the gateway neither buffers nor parses its body: the 401 is sent at once
  and the connection is closed instead of drained. A malformed upstream response is logged only
  as its length and content type, never its text.
- **Upstream 400 maps to `upstream_rejected` (502), not `invalid_request` (400).** Our gateway
  accepted the request as valid. The provider refusing it is an upstream outcome, and its reason
  (which may echo internals) is not passed on. If a refusal were really the client's fault, a
  production version could map specific, well-known upstream codes to `invalid_request`.
- **Failures release the reservation.** No completion means no charge to the tenant. The
  trade-off: a timed-out call that the provider still finishes and bills us for is not charged to
  the tenant's window. See the production notes.
- **The request's `model` is logical.** Each provider sends its configured upstream model
  (`PRIMARY_MODEL` / `SECONDARY_MODEL`). The response reports the model actually used, and the
  request log stores the one that was requested.

## What I would do in production

- **A real tokenizer.** Count prompt tokens with the provider's tokenizer (tiktoken for OpenAI
  models) or its `count_tokens` endpoint, so admission is exact for the prompt half. Only the
  completion ceiling would stay an estimate.
- **Circuit breaker with a half-open state per provider.** After N consecutive failures (or a high
  error rate), skip the primary for a cool-down period, then let one probe request through
  (half-open) before closing the breaker again. This avoids paying a 3 s timeout on every request
  during an outage.
- **Hedged requests** for latency-sensitive tenants: start the secondary after the primary's p95
  latency instead of waiting for the full timeout, and take whichever answers first. The race code
  already cancels the loser. Hedging costs extra budget, so it should be opt-in.
- **Overall request deadline and client cancellation.** Cap the total time across both attempts.
  Abort upstream calls when the client disconnects. For calls that time out, charge the prompt
  estimate rather than nothing, because the upstream may still bill us.
- **Per-model and per-provider limits.** Track windows keyed by (tenant, model) and our own
  provider-wide quotas. Use the upstream `Retry-After` to pause a provider instead of rediscovering
  the 429 on every request.
- **Idempotency keys.** Accept an `Idempotency-Key` header and store it with the request id, so a
  client retry after a network blip does not run, or get charged for, a completion twice.
- **Shared state at scale.** Move the window to Redis sorted sets (or per-second summary rows), as
  described above. Keep SQLite or Postgres for the tenants table and the request log.
- **Streaming responses** (SSE), with token accounting settled from the final usage chunk.
- **Key management.** Provision tenants through an admin API, rotate keys, and use a keyed hash
  (HMAC with a server secret) rather than a bare SHA-256.
- **Observability.** Prometheus counters and histograms (admitted or denied, failover reasons,
  attempt latency per provider) and OpenTelemetry traces that span the gateway and upstream calls.
