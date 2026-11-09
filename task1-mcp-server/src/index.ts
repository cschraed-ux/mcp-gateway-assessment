#!/usr/bin/env node
/**
 * Entry point. stdout belongs to the JSON-RPC stdio transport, so the very first statements
 * redirect console.log/info/debug to stderr; dynamic imports follow so that nothing loaded later
 * (including dependencies) can print to stdout through console. stdin is piped through
 * stdin-guard so malformed lines get a JSON-RPC error instead of being silently dropped.
 */
import { format } from "node:util";

for (const m of ["log", "info", "debug"] as const) {
  console[m] = (...a: unknown[]) => {
    process.stderr.write(format(...a) + "\n");
  };
}

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = await import("./server.js");
const { logger } = await import("./logger.js");
const { createStdinGuard } = await import("./stdin-guard.js");

const server = createServer();
// Malformed lines are answered by the guard (-32700 / -32600); only valid messages reach the SDK.
const guard = createStdinGuard((err) => {
  logger.warn("rejected malformed message", { code: err.error.code, id: err.id });
  void transport.send(err as unknown as Parameters<typeof transport.send>[0]);
});
const transport = new StdioServerTransport(process.stdin.pipe(guard), process.stdout);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info("shutting down", { signal });
  try {
    await transport.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.connect(transport);
logger.info("server ready", { transport: "stdio" });
