// Shared test helpers: start servers on ephemeral ports and stop them without hanging vitest.
import type http from "node:http";
import { once } from "node:events";
import { createLogger, type Logger } from "../src/logger.js";

export async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

export async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A port that nothing listens on: bind an ephemeral port, then release it. */
export async function closedPort(server: http.Server): Promise<number> {
  const url = await listen(server);
  await close(server);
  return Number(new URL(url).port);
}

export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: "debug", sink: (l) => lines.push(l) }), lines };
}
