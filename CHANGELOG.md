# Changelog

_Generated from git history after every commit — do not edit by hand._

Each entry records what was requested, what changed, which files were
touched, and how to undo it. Newest first.

---

## 2026-11-08 23:48 — Record the local commit in DECISIONS, QUESTIONS and TESTING

`c1e93ff` · Chad M. Schraeder

<details>
<summary><strong>3 file(s) changed</strong></summary>

- modified — `DECISIONS.md`
- modified — `QUESTIONS.md`
- modified — `TESTING.md`

</details>

- **See the full diff:** `git show c1e93ff`
- **Undo only this change:** `git revert c1e93ff`
- **Roll back to this point (discards everything after):** `git reset --hard c1e93ff`

---

## 2026-11-08 23:48 — Solution Architect assessment: four MCP/LLM gateway tasks

`be7c6fe` · Chad M. Schraeder

Task 1: MCP server over stdio with strict Zod validation and real
JSON-RPC -32602/-32700/-32600 errors (SDK handler replaced, stdin guard).
Task 2: MCP security gateway proxy with HS256 role auth, admin_* tool
authorization (-32001), batch splitting, downstream error sanitization.
Task 3: streaming LLM gateway with a pattern-aware hold-back PII redactor
(emails, SSNs, Luhn-validated cards), bounded memory and TTFT.
Task 4: token-aware sliding-window rate limiter on SQLite with
reserve-then-settle accounting, 3000 ms timeout race and primary to
secondary model failover, standardized error payloads.

287 tests pass across the four workspaces; see TESTING.md and DECISIONS.md.

<details>
<summary><strong>88 file(s) changed</strong></summary>

- added — `.gitignore`
- added — `.nvmrc`
- added — `AGENTS.md`
- added — `DECISIONS.md`
- added — `QUESTIONS.md`
- added — `README.md`
- added — `TESTING.md`
- added — `package-lock.json`
- added — `package.json`
- added — `scripts/check-duplicates.mjs`
- added — `task1-mcp-server/README.md`
- added — `task1-mcp-server/package.json`
- added — `task1-mcp-server/src/customers.ts`
- added — `task1-mcp-server/src/index.ts`
- added — `task1-mcp-server/src/logger.ts`
- added — `task1-mcp-server/src/schemas.ts`
- added — `task1-mcp-server/src/server.ts`
- added — `task1-mcp-server/src/stdin-guard.ts`
- added — `task1-mcp-server/test/customers.test.ts`
- added — `task1-mcp-server/test/no-stdout-in-src.test.ts`
- added — `task1-mcp-server/test/stdin-guard.test.ts`
- added — `task1-mcp-server/test/stdio-isolation.test.ts`
- added — `task1-mcp-server/test/validation.test.ts`
- added — `task1-mcp-server/tsconfig.json`
- added — `task1-mcp-server/vitest.config.ts`
- added — `task2-mcp-gateway/README.md`
- added — `task2-mcp-gateway/package.json`
- added — `task2-mcp-gateway/src/auth.ts`
- added — `task2-mcp-gateway/src/config.ts`
- added — `task2-mcp-gateway/src/gateway.ts`
- added — `task2-mcp-gateway/src/index.ts`
- added — `task2-mcp-gateway/src/jsonrpc.ts`
- added — `task2-mcp-gateway/src/logger.ts`
- added — `task2-mcp-gateway/src/mock-downstream.ts`
- added — `task2-mcp-gateway/src/policy.ts`
- added — `task2-mcp-gateway/test/auth.test.ts`
- added — `task2-mcp-gateway/test/config.test.ts`
- added — `task2-mcp-gateway/test/gateway.test.ts`
- added — `task2-mcp-gateway/test/helpers.ts`
- added — `task2-mcp-gateway/test/jsonrpc.test.ts`
- added — `task2-mcp-gateway/test/policy.test.ts`
- added — `task2-mcp-gateway/tsconfig.json`
- added — `task2-mcp-gateway/vitest.config.ts`
- added — `task3-llm-guardrail/README.md`
- added — `task3-llm-guardrail/package.json`
- added — `task3-llm-guardrail/src/config.ts`
- added — `task3-llm-guardrail/src/demo-text.ts`
- added — `task3-llm-guardrail/src/detectors.ts`
- added — `task3-llm-guardrail/src/gateway.ts`
- added — `task3-llm-guardrail/src/index.ts`
- added — `task3-llm-guardrail/src/logger.ts`
- added — `task3-llm-guardrail/src/mock-provider.ts`
- added — `task3-llm-guardrail/src/providers/anthropic.ts`
- added — `task3-llm-guardrail/src/providers/mock.ts`
- added — `task3-llm-guardrail/src/providers/openai-compatible.ts`
- added — `task3-llm-guardrail/src/providers/types.ts`
- added — `task3-llm-guardrail/src/redactor.ts`
- added — `task3-llm-guardrail/src/sse.ts`
- added — `task3-llm-guardrail/test/bench.ts`
- added — `task3-llm-guardrail/test/gateway.test.ts`
- added — `task3-llm-guardrail/test/helpers.ts`
- added — `task3-llm-guardrail/test/providers.test.ts`
- added — `task3-llm-guardrail/test/redactor.test.ts`
- added — `task3-llm-guardrail/test/sse.test.ts`
- added — `task3-llm-guardrail/tsconfig.json`
- added — `task3-llm-guardrail/vitest.config.ts`
- added — `task4-model-router/README.md`
- added — `task4-model-router/package.json`
- added — `task4-model-router/src/config.ts`
- added — `task4-model-router/src/db.ts`
- added — `task4-model-router/src/errors.ts`
- added — `task4-model-router/src/index.ts`
- added — `task4-model-router/src/logger.ts`
- added — `task4-model-router/src/mock-providers.ts`
- added — `task4-model-router/src/pipeline.ts`
- added — `task4-model-router/src/providers.ts`
- added — `task4-model-router/src/rate-limiter.ts`
- added — `task4-model-router/src/router.ts`
- added — `task4-model-router/src/server.ts`
- added — `task4-model-router/src/tokens.ts`
- added — `task4-model-router/test/fixtures/reserve-worker.ts`
- added — `task4-model-router/test/helpers.ts`
- added — `task4-model-router/test/rate-limiter.test.ts`
- added — `task4-model-router/test/router.test.ts`
- added — `task4-model-router/test/server.test.ts`
- added — `task4-model-router/tsconfig.json`
- added — `task4-model-router/vitest.config.ts`
- added — `tsconfig.base.json`

</details>

- **See the full diff:** `git show be7c6fe`
- **Undo only this change:** `git revert be7c6fe`
- **Roll back to this point (discards everything after):** `git reset --hard be7c6fe`

