/**
 * Entry point: reads configuration from the environment, builds the selected provider adapter
 * (mock by default, so `npm run dev` works with no API key), and starts the gateway.
 */
import { loadConfig } from "./config.js";
import { DEMO_TEXT } from "./demo-text.js";
import { createGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import type { Provider } from "./providers/types.js";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);
for (const w of cfg.warnings) log.warn("config", { warning: w });

function buildProvider(): Provider {
  switch (cfg.provider) {
    case "openai":
      if (!cfg.openaiApiKey) throw new Error("PROVIDER=openai requires OPENAI_API_KEY");
      return new OpenAICompatibleProvider({
        baseUrl: cfg.openaiBaseUrl,
        apiKey: cfg.openaiApiKey,
        ...(cfg.openaiModel ? { defaultModel: cfg.openaiModel } : {}),
      });
    case "anthropic":
      if (!cfg.anthropicApiKey) throw new Error("PROVIDER=anthropic requires ANTHROPIC_API_KEY");
      return new AnthropicProvider({
        apiKey: cfg.anthropicApiKey,
        apiVersion: cfg.anthropicVersion,
        fallbacks: cfg.anthropicFallbacks ? "default" : null,
        ...(cfg.anthropicModel ? { defaultModel: cfg.anthropicModel } : {}),
      });
    case "mock":
      return new MockProvider({ text: DEMO_TEXT, chunking: { kind: "fixed", size: 3 }, delayMs: 40 });
  }
}

let provider: Provider;
try {
  provider = buildProvider();
} catch (err) {
  log.error("startup_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const server = createGateway({
  provider,
  logger: log,
  maxHoldChars: cfg.maxHoldChars,
  idleFlushMs: cfg.idleFlushMs,
  maxResponseBytes: cfg.maxResponseBytes,
  firstByteGraceMs: cfg.firstByteGraceMs,
  requestTimeoutMs: cfg.requestTimeoutMs,
  headersTimeoutMs: cfg.headersTimeoutMs,
});

server.listen(cfg.port, cfg.host, () => {
  log.info("gateway_listening", {
    url: `http://${cfg.host}:${cfg.port}/v1/generate`,
    provider: provider.name,
    max_hold_chars: cfg.maxHoldChars,
    idle_flush_ms: cfg.idleFlushMs,
  });
});

const shutdown = (): void => {
  log.info("shutting_down");
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
