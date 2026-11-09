# Task 3: LLM gateway with a real-time PII redaction guardrail

An HTTP gateway that sends a text-generation request to an LLM provider and streams the answer
back to the client as Server-Sent Events (SSE). While the answer streams, it finds e-mail
addresses, US Social Security numbers and credit card numbers and replaces them with
`[REDACTED]`, including values split across chunks (`"john.d"`, `"oe@exam"`, `"ple.com"`). It
never holds the full response in memory: at most 320 characters are held at any moment (the cap),
and in ordinary prose only the last word.

- Node 24 built-ins only (`node:http`, global `fetch`, Web Streams). No runtime dependencies.
- Providers: a built-in **mock** (the default, so it runs with no API key), any
  **OpenAI-compatible** Chat Completions endpoint, and the **Anthropic** Messages API.

## Quick start

All commands run from this folder (`task3-llm-guardrail`) after `npm install` at the repo root.
Every port can be overridden if it is already in use locally: the gateway with `PORT` (for
example `PORT=9082 npm run dev`) and the mock upstream with `MOCK_PROVIDER_PORT` (for example
`MOCK_PROVIDER_PORT=9083 npm run dev:provider`, then `OPENAI_BASE_URL=http://127.0.0.1:9083/v1`).

### 1. Simplest: built-in mock provider

```bash
npm run dev
```

In a second terminal:

```bash
curl -N http://127.0.0.1:8082/v1/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"Find the customer record for Jane"}'
```

### 2. End to end over real HTTP: mock OpenAI-compatible server + gateway

This runs two HTTP servers, so the gateway talks to an "upstream" over a real socket, exactly as
it would talk to OpenAI.

1. Terminal 1: start the mock upstream (it listens on `http://127.0.0.1:8083/v1` and streams a
   canned answer with an e-mail, an SSN and a card in 3-character chunks every 40 ms):

   ```bash
   npm run dev:provider
   ```

2. Terminal 2: start the gateway and point it at the mock:

   ```bash
   PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:8083/v1 OPENAI_API_KEY=x npm run dev
   ```

3. Terminal 3: stream a response. `-N` turns off curl's buffering, so you watch the words arrive
   live and the PII arrive as `[REDACTED]`:

   ```bash
   curl -N http://127.0.0.1:8082/v1/generate \
     -H 'content-type: application/json' \
     -d '{"prompt":"Find the customer record for Jane"}'
   ```

Output (trimmed; one event per released word):

```
data: {"delta":"Sure! "}
data: {"delta":"I "}
...
data: {"delta":"at "}
data: {"delta":"[REDACTED] "}
data: {"delta":"or "}
data: {"delta":"call "}
data: {"delta":"555-123-4567. "}
...
data: {"delta":"is "}
data: {"delta":"[REDACTED] "}
...
data: {"delta":"[REDACTED] ("}
data: {"delta":"order "}
data: {"delta":"1234-5678, "}
data: {"delta":"reference "}
data: {"delta":"1234567812345678)"}
...
data: {"done":true,"request_id":"279c53d4-...","stats":{"ttft_ms":91.13,"total_ms":3760.77,"chars_in":273,"chars_out":253,"max_held_chars":20,"redactions":{"EMAIL":1,"SSN":1,"CREDIT_CARD":1,"total":3}}}
```

The phone number, the order number and the 16-digit reference (it fails the Luhn check) pass
through unchanged. In the gateway's log, `upstream_first_delta_ms` was 49.6 and `ttft_ms` 91.1:
the guardrail held the first 3-character chunk `"Sur"` until the word was complete (one more
40 ms chunk), which is exactly the "one word" of latency it adds.

More requests to try against the same gateway:

```bash
# One JSON body instead of SSE (still redacted on the way through)
curl -s http://127.0.0.1:8082/v1/generate -H 'content-type: application/json' \
  -d '{"prompt":"Find Jane","stream":false}'

# Upstream failure before the first token: a clean 502, nothing from the upstream body
# (the mock answers model "fail-401" with a 401 whose body contains a fake secret)
curl -si http://127.0.0.1:8082/v1/generate -H 'content-type: application/json' \
  -d '{"prompt":"x","model":"fail-401"}'

# Validation error
curl -si http://127.0.0.1:8082/v1/generate -H 'content-type: application/json' -d '{"model":"x"}'

# Health check
curl -s http://127.0.0.1:8082/healthz
```

### 3. A real provider

Anthropic (default model `claude-sonnet-5-5`, `anthropic-version: 2023-06-01`; set
`ANTHROPIC_VERSION` to use a newer API version date):

```bash
PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

OpenAI, or any OpenAI-compatible server (vLLM, Ollama, LiteLLM):

```bash
PROVIDER=openai OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini npm run dev
```

Then use the same `curl -N` command from step 2.3 above. To ask the model to produce PII on
purpose:

```bash
curl -N http://127.0.0.1:8082/v1/generate -H 'content-type: application/json' \
  -d '{"prompt":"Invent a fake customer and list their email, SSN and Visa test card 4111 1111 1111 1111."}'
```

### Tests, build, benchmark

```bash
npm run typecheck
npm test
npm run build && npm start      # production build, same env vars
npm run bench
```

## API

`POST /v1/generate`, `Content-Type: application/json`:

| Field        | Type    | Notes                                              |
|--------------|---------|----------------------------------------------------|
| `prompt`     | string  | required, non-empty                                |
| `model`      | string  | optional, provider default otherwise               |
| `max_tokens` | integer | optional, 1 to 128000                              |
| `system`     | string  | optional system prompt                             |
| `stream`     | boolean | default `true`                                     |

Streaming response (`text/event-stream`): `data: {"delta":"..."}` events, then
`data: {"done":true,"request_id":...,"stats":{ttft_ms,total_ms,chars_in,chars_out,max_held_chars,redactions}}`.
A failure after streaming started is sent as `event: error` with
`data: {"error":{"code":"upstream_error","message":...,"request_id":...}}`, then the stream closes.

`stream: false` returns `{"id","text","stats"}`.

Errors are always `{"error":{"code","message","request_id"}}`; the request id is also in the
`X-Request-Id` header and in every log line for that request.

| Status | `code`                    | When                                                    |
|--------|---------------------------|---------------------------------------------------------|
| 400    | `invalid_json`            | body is not JSON                                        |
| 400    | `invalid_request`         | missing `prompt`, wrong field types                     |
| 404 / 405 / 415 | `not_found` / `method_not_allowed` / `unsupported_media_type` | wrong route, method or content type |
| 413    | `payload_too_large`       | request body over 1 MB                                  |
| 502    | `upstream_error`          | provider failed before the first token (or at any point with `stream:false`) |
| 502    | `response_too_large`      | `stream:false` output over `MAX_RESPONSE_BYTES`         |

### Configuration (environment variables)

| Variable              | Default                     | Meaning                                                  |
|-----------------------|-----------------------------|----------------------------------------------------------|
| `PROVIDER`            | `mock`                      | `mock`, `openai` or `anthropic`                          |
| `PORT` / `HOST`       | `8082` / `127.0.0.1`        | listen address                                           |
| `OPENAI_BASE_URL`     | `https://api.openai.com/v1` | any OpenAI-compatible base URL                           |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | none, `gpt-4o-mini` | key (required for `openai`), default model |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | none, `claude-sonnet-5-5` | key (required for `anthropic`), default model |
| `ANTHROPIC_VERSION`   | `2023-06-01`                | `anthropic-version` header (known-good and still accepted; newer API version dates exist and can be set here) |
| `ANTHROPIC_FALLBACKS` | off                         | set to `default` to send the server-side refusal fallback (`fallbacks: "default"` plus the `anthropic-beta: server-side-fallback-2026-07-01` header); off by default so an account without that beta is never rejected |
| `MAX_HOLD_CHARS`      | `320`                       | hold-back cap: the most characters the guardrail may hold |
| `IDLE_FLUSH_MS`       | `0` (off)                   | opt-in liveness: release a held plain word after this much upstream silence (e.g. `250`); can expose an e-mail's local part, see Limits |
| `FIRST_BYTE_GRACE_MS` | `1000`                      | how long to wait for the first token before committing `200` headers |
| `REQUEST_TIMEOUT_MS`  | `30000`                     | time a client may take to send the whole request (`server.requestTimeout`); bounds receiving the request only, not the streamed response, so long streams are unaffected |
| `HEADERS_TIMEOUT_MS`  | `10000`                     | time a client may take to send the request headers (`server.headersTimeout`); request side only, like the row above |
| `MAX_RESPONSE_BYTES`  | `1048576`                   | cap for `stream:false` bodies                            |
| `LOG_LEVEL`           | `info`                      | `debug`, `info`, `warn`, `error`, `silent`               |

## Architecture

```
client ──POST──> gateway.ts ──> Provider adapter ──> AsyncIterable<string> (text deltas only)
                   │              (mock | openai-compatible | anthropic, each parses its own SSE
                   │               with sse.ts)
                   │
                   └── ReadableStream(deltas) ─pipeThrough─> StreamRedactor TransformStream
                                                                   │  (redactor.ts + detectors.ts)
                                         SSE writer <── redacted pieces as soon as they are safe
```

| File | Role |
|------|------|
| `src/redactor.ts` | `StreamRedactor` (`push`, `flush`, `releaseIdle`, stats), `redactText`, `createRedactorTransform` |
| `src/detectors.ts` | the e-mail, SSN and card detectors: full regex, end-anchored prefix regex, literal hint, validator |
| `src/sse.ts` | SSE parser over a byte stream: chunk-split events, CRLF, multi-line `data:`, split UTF-8 |
| `src/providers/*.ts` | `Provider` interface, mock, OpenAI-compatible and Anthropic adapters |
| `src/gateway.ts` | HTTP handling, validation, header timing, backpressure, abort, error mapping, stats |
| `src/mock-provider.ts` | standalone OpenAI-compatible SSE server for demos and adapter tests |
| `src/index.ts`, `src/config.ts`, `src/logger.ts` | entry point, env config, JSON-lines logger on stderr |

Every provider adapter turns its wire format into one thing: an async iterable of plain text
deltas. The guardrail and the HTTP layer are therefore written once and know nothing about
OpenAI or Anthropic event names.

## The redaction algorithm: pattern-aware hold-back

The difficulty is that a chunk boundary can fall anywhere: an e-mail can arrive as `"john.d"`,
`"oe@exam"`, `"ple.com"`. Scanning each chunk alone misses it. Buffering the whole response
catches it but destroys time to first token and uses memory proportional to the answer.

The redactor keeps a small `pending` string and, on every `push(chunk)`:

1. Appends the chunk: `text = pending + chunk`.
2. Finds the **hold point**: the leftmost position from which the tail of `text` could still be,
   or grow into, a sensitive value once more characters arrive. Each detector has a **prefix
   regex anchored at the end** (`$`) for this. For e-mail it is
   `[A-Za-z0-9._%+-]{1,64}(?:@[A-Za-z0-9.-]{0,320})?$`: "a run of local-part characters,
   optionally followed by `@` and domain characters, reaching the end of the text". For a card it
   is `\b(?:\d[ -]?){1,19}$`. The hold point is the smallest match start over all detectors,
   but never more than `maxHold` (default 320) characters from the end.
3. Scans everything **before** the hold point with the full detectors, replaces each accepted
   match with `[REDACTED]`, and returns that text for immediate sending.
4. Keeps only the tail (from the hold point) as the new `pending`.

`flush()` at the end of the stream scans what is left with nothing held back.

### Worked example: an e-mail split across three chunks

| Call | `pending + chunk` | Hold point (why) | Emitted now | Held after |
|------|-------------------|------------------|-------------|------------|
| `push("Contact john.d")` | `Contact john.d` | at `john.d` (could be a local part) | `Contact ` | `john.d` |
| `push("oe@exam")` | `john.doe@exam` | at `john.doe@exam` (local part + `@` + domain so far) | *(nothing)* | `john.doe@exam` |
| `push("ple.com rest")` | `john.doe@example.com rest` | at `rest` (the e-mail is followed by a space, so it can no longer grow) | `[REDACTED] ` | `rest` |
| `flush()` | `rest` | end of stream | `rest` | *(empty)* |

Note the third push: `john.doe@example.com` is complete, but it is *not* redacted on the second
push, `john.doe@exam`, nor would it be if the chunk had ended at `.com`, because `.com` could
still become `.com.au`. A match is only final once the character after it shows it cannot be
extended. That is what makes the output independent of how the stream was chunked.

### Why the output does not depend on chunking

At a position before the hold point, no detector's prefix regex matches, so no future text can
change what the regexes find there: a candidate that starts there is already complete (it is
followed by a character that cannot continue it) or impossible. The scanner picks the leftmost
candidate across detectors (longest wins a tie, so `123-45-6789@x.com` is one e-mail, not an SSN
followed by `@x.com`), exactly as the one-shot `redactText` does. One raw character of
already-sent text is kept as left context, so `\b` sees the same neighbour it would see in the
full text (`x4111...` is not a card in either mode).

The property test checks this directly: for 200 random texts (safe words, e-mails, SSNs,
Luhn-valid cards, invalid-Luhn 16-digit numbers, phone numbers, dates, emoji) and 20 random
chunkings each, including 1-character chunks and the whole text as one chunk, the concatenated
`push` outputs plus `flush()` equal `redactText(fullText)`. It runs once with glued-together
adversarial tokens and the default 320 cap, and once with prose-like text and a tight 64 cap.

### Other properties

- **A `[REDACTED]` token is never re-scanned or held.** Replacements are written only to the
  output, never back into `pending`.
- **Bounded memory and work.** `pending` is at most `maxHold` characters after every push. Each
  push costs O(`maxHold` + chunk length); every regex quantifier is bounded (64-character local
  part, 255-character domain, 19 card digits), so there is no catastrophic backtracking. Regexes
  are compiled once. No list of chunks is ever kept.
- **Cheap pre-filter.** Like grep's literal pre-filter, the e-mail regex is skipped when the text
  has no `@` and the SSN and card regexes are skipped when it has no digit.
- **No split characters.** A cut never separates the two halves of a UTF-16 surrogate pair
  (emoji).

## Latency and time to first token (TTFT)

- **Bounded hold-back.** For prose the held tail is the last word (every word could be the start
  of an e-mail's local part), so the guardrail adds "the rest of the current word" of latency,
  not "the rest of the answer". The cap (`MAX_HOLD_CHARS`, default 320) is a hard upper bound
  that is only reached inside a long address-like run. 320 characters is a 64-character local part,
  the `@` and a full-length domain, so an RFC-length e-mail is never cut by the cap. In normal prose
  the hold is still just the trailing word, so the larger cap does not change TTFT: the bench shows
  the same `maxHeld` (about 30 characters) with a cap of 320 as with a cap of 64.
- **Idle flush (opt-in, off by default).** If the upstream pauses (a reasoning model thinking, a
  slow network), a held plain word waits for the next token or the end of the stream. By default
  that is all that happens, so the output is exactly `redactText(fullText)` and a pause can never
  expose anything. Setting `IDLE_FLUSH_MS=250` turns on a liveness trade-off: after 250 ms of
  silence the transform releases held text that has made no real progress toward PII, a trailing
  word without `@` or digits. A partial e-mail (`jane@exa`) or a digit run stays held, and an
  `@domain.tld` arriving right after a released word is still redacted; what it can expose is an
  e-mail's local part (see Limits).
- **No response-level buffering anywhere.** Each released piece is written to the socket at once,
  and Nagle's algorithm is disabled on the socket (`setNoDelay`) so small SSE frames are not
  delayed waiting to be combined. `Cache-Control: no-cache, no-transform` and
  `X-Accel-Buffering: no` stop proxies (nginx) from buffering the stream.
- **Header timing.** The upstream call starts as soon as the body is parsed. Headers are sent on
  the first token, or after `FIRST_BYTE_GRACE_MS` (1 s) with an SSE comment so the connection is
  established, whichever is first. Waiting that one short grace period lets the common fast
  failures (bad API key, 429, 5xx, which come back in one round trip) be a real HTTP `502`
  instead of a `200` that turns into an error event; it does not delay the first token, because
  the client has nothing to show before it anyway. Set `FIRST_BYTE_GRACE_MS=0` to send headers
  immediately on receipt.
- **Backpressure end to end.** When the client reads slowly, `res.write()` returns false and the
  writer waits for `drain`, so it stops reading from the redactor, which stops pulling from the
  provider (the source stream has `highWaterMark: 0`). Nothing piles up in the gateway.
- **Client disconnect** aborts the upstream request through an `AbortController`, so a closed
  browser tab stops token spending.
- `ttft_ms` in the done event is measured from request arrival to the first emitted delta; the
  log line also has `upstream_first_delta_ms`, so the guardrail's own added latency is visible.

## Detectors

| Type | Pattern | Validation | False positives it avoids |
|------|---------|-----------|---------------------------|
| `EMAIL` | `local@domain.tld`: local part `[A-Za-z0-9._%+-]{1,64}`, domain `[A-Za-z0-9.-]{1,255}`, TLD 2 to 63 letters | none beyond the shape | `a@` alone, `@handle`, `v1.2.3` |
| `SSN` | `\b\d{3}([- ])\d{2}\1\d{4}\b`: dashes or spaces, the same separator twice | area not 000, 666 or 900 to 999; group not 00; serial not 0000 (never issued) | phone `555-123-4567` (wrong shape), `123-45 6789` (mixed separators), IDs glued to letters |
| `CREDIT_CARD` | `\b(?:\d[ -]?){12,18}\d\b`: 13 to 19 digits, single optional space or dash between digits | **Luhn checksum**; the candidate is trimmed back to its longest Luhn-valid prefix of at least 13 digits | order `1234-5678` (too short), phone numbers, random 16-digit IDs (90% fail Luhn), ISBN `978-0-306-40615-7` |

Priority when two detectors match the same span: SSN, then card, then e-mail. A 9-digit number
without separators is not an SSN here (it would hit far too many order numbers and IDs) and is
too short to be a card. The trimming step matters for text like `4111 1111 1111 1111 2024`:
the greedy regex sees 20 digits, which fails Luhn, but the first 16 pass, so the card is caught
and `2024` is left alone. `redactText(..., { typedLabels: true })` and the `typedLabels` option
emit `[REDACTED:EMAIL]` etc. instead of the plain `[REDACTED]` the task asks for.

## Limits (honest list)

- **Patterns only, no NER.** Names, addresses, and PII written out in words
  ("one two three, four five...") are not detected. A model asked to obfuscate can evade regexes.
- **ASCII e-mails only.** Internationalised addresses (`josé@exämple.de`) are not matched.
- **The hold cap trades completeness for latency.** A single candidate longer than `maxHold` is
  cut at the cap, and the part beyond it may be emitted unredacted. With the default of 320 that
  cannot happen for an RFC-length e-mail (64 + 1 + 255 characters) or a card (at most 37); lowering
  `MAX_HOLD_CHARS` (for example to 64) shortens the worst-case hold but can cut very long addresses.
- **Opt-in idle flush can leak a local part.** Only with `IDLE_FLUSH_MS` > 0 (for example
  `IDLE_FLUSH_MS=250`; the default 0 cannot leak anything this way): if the upstream pauses for longer than `IDLE_FLUSH_MS`
  exactly in the middle of an e-mail's local part (`john.d` | pause | `oe@example.com`), `john.d`
  is released and only `oe@example.com` is redacted. If the pause falls right before the `@`
  (`john.doe` | pause | `@example.com`), the redactor remembers that the released word could be a
  local part and still redacts the `@example.com` that follows, so at most the local part is
  exposed, never the domain. Leave `IDLE_FLUSH_MS` at 0 to rule this out.
- **Characters, not tokens.** The cap is in UTF-16 characters; the gateway never needs to know the
  provider's tokenizer, but the 320-character cap is roughly 80 tokens of latency in the worst case
  (only inside a long address-like run; prose holds one word).
- **`stream:false` accumulates by definition**, capped at `MAX_RESPONSE_BYTES` (1 MB); beyond
  that the gateway aborts the upstream and answers `502 response_too_large`.
- **Mid-stream upstream errors drop the held tail** instead of flushing it, because the tail is by
  construction text that might be the start of PII (fail closed). The client gets `event: error`.

## Benchmark

`npm run bench` streams 1 MB of synthetic model output (prose, with PII and look-alikes in about
20% of sentences) through the redactor, checks the result equals `redactText`, and prints:

```
input: 1.00 MB (UTF-16 code units ~ bytes for ASCII)
--- measured ---
maxHold=320  chunk=   1B  pushes=1048576  throughput=   3.3 MB/s  push p50=0.2us p99=1.3us  maxHeld=30 chars  redactions=10911
maxHold=320  chunk=  20B  pushes=  52429  throughput=  20.3 MB/s  push p50=0.5us p99=2.5us  maxHeld=29 chars  redactions=10911
maxHold=320  chunk=  64B  pushes=  16384  throughput=  32.1 MB/s  push p50=1.0us p99=5.5us  maxHeld=29 chars  redactions=10911
maxHold=320  chunk= 256B  pushes=   4096  throughput=  34.4 MB/s  push p50=6.6us p99=16.3us  maxHeld=27 chars  redactions=10911
maxHold=320  chunk=4096B  pushes=    256  throughput=  54.7 MB/s  push p50=70.3us p99=94.1us  maxHeld=19 chars  redactions=10911
maxHold= 64  chunk=   1B  pushes=1048576  throughput=   3.2 MB/s  push p50=0.2us p99=1.2us  maxHeld=30 chars  redactions=10911
maxHold= 64  chunk=  20B  pushes=  52429  throughput=  16.5 MB/s  push p50=0.5us p99=4.1us  maxHeld=29 chars  redactions=10911
maxHold= 64  chunk=  64B  pushes=  16384  throughput=  26.9 MB/s  push p50=1.2us p99=11.1us  maxHeld=29 chars  redactions=10911
maxHold= 64  chunk= 256B  pushes=   4096  throughput=  46.9 MB/s  push p50=4.7us p99=22.8us  maxHeld=27 chars  redactions=10911
maxHold= 64  chunk=4096B  pushes=    256  throughput=  42.8 MB/s  push p50=74.7us p99=241.0us  maxHeld=19 chars  redactions=10911
one-shot redactText (no streaming): 56.0 MB/s
```

(Apple Silicon laptop, Node 24.12; run-to-run variation is about 20%.) The cap does not change
how much is held in prose: `maxHeld` is identical for 320 and 64. At 20-byte chunks, which is about the size of a real
streaming delta, one push costs about half a microsecond. A fast model streams around 100
tokens a second, roughly 400 bytes, so the guardrail uses a tiny fraction of one core per stream.
The gateway memory test streams 2 MB through HTTP in 64-byte chunks and measures about 2 to 3 MB
of retained heap growth mid-stream (mostly the mock's own chunk list), and asserts
`max_held_chars` stays within the 320 cap.

## Tests

`npm test` runs 67 tests in four files:

- `test/redactor.test.ts`: the chunking-invariance property test (2 x 4000 streamed runs),
  boundary cases (the three-chunk e-mail, an SSN split between every character, a spaced card split
  mid-group, back-to-back e-mails, an e-mail only revealed by `flush`, an e-mail that could still
  grow, PII-free text held only by its last word, surrogate pairs at the cap, a lone surrogate
  before a card), false positives, stats and the cap, the TransformStream wrapper including idle
  flush with injected timers, and an idle flush that lands right before an `@`.
- `test/sse.test.ts`: the SSE parser at every possible split point, random multi-way splits,
  1-byte chunks, CRLF / CR / LF, a 4-byte emoji split across three chunks, the line cap, no
  dispatch for an `event:`-only block, and linear-time parsing of one 4 MB chunk.
- `test/gateway.test.ts`: a real gateway on port 0 with a 1-character, 2 ms-per-chunk mock:
  the first event arrives while the mock has produced less than a quarter of its chunks, the
  deltas equal the redacted text with 3 `[REDACTED]`, the stats in the done event; `stream:false`
  and its size cap; validation errors (400, 404, 405, 415); a 502 with no upstream detail when the
  provider fails before the first token; an `event: error` and no flushed tail mid-stream; client
  abort reaching the provider's `AbortSignal`; the 2 MB memory test.
- `test/providers.test.ts`: the OpenAI-compatible adapter against the real mock SSE server (text,
  401, in-stream error, request shape) and the Anthropic adapter against a recorded event fixture
  (thinking and signature deltas skipped, `ping`, `message_stop`, `error` events, headers and body,
  the refusal fallback and its beta header sent only when opted in).

## What I would do in production

- **Per-tenant policies.** Which detectors run, typed or plain labels, `maxHold`, and whether to
  block the whole response instead of redacting, chosen per API key or route.
- **Allow-lists for known-safe values**: the company's own support address, documented test card
  numbers, so they are not redacted.
- **More detectors behind the same interface**: IBANs (mod-97 check), phone numbers, API keys and
  JWTs (high-entropy tokens with known prefixes), and an optional NER model for names and
  addresses on the non-streaming path, where latency matters less.
- **Redaction on the request path too**, so PII in prompts is not sent to a third-party provider
  in the first place (and not retained in its logs).
- **Audit metrics**: redactions per type and tenant, held-characters histogram, guardrail-added
  latency (`ttft_ms - upstream_first_delta_ms`), idle flushes, cap hits, exported to Prometheus or
  OpenTelemetry, never the redacted values themselves.
- **Operational hardening**: authentication and rate limiting in front of the gateway, upstream
  retries before the first token only, a request deadline, connection pooling to the provider, and
  graceful drain on deploy so in-flight streams finish.
- Use the official Anthropic and OpenAI SDKs in the adapters if dependencies are allowed; they
  handle retries, typed errors and new event types. This task forbids runtime dependencies, so
  the adapters use `fetch` and the bundled SSE parser.
