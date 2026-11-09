/**
 * Line filter that sits between process.stdin and the SDK's StdioServerTransport. Design choice:
 * SDK 1.32's stdio transport silently drops a line it cannot parse (it only calls onerror), so a
 * client that sends broken JSON, a batch array or a bad envelope would wait forever. This guard
 * answers those lines itself with the standard JSON-RPC errors (-32700 parse error, -32600 invalid
 * request, `id` echoed when it can be recovered, otherwise `null`) and passes only well-formed
 * messages through. Memory is bounded: a line longer than MAX_LINE_BYTES is discarded up to its
 * newline and answered with -32600. MCP (2025-06-18) has no batches, so arrays are invalid requests.
 */
import { Transform, type TransformCallback } from "node:stream";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

export const MAX_LINE_BYTES = 1024 * 1024;

export type ErrorReply = { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

function errorReply(id: string | number | null, code: number, message: string): ErrorReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function recoverId(v: unknown): string | number | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const id = (v as { id?: unknown }).id;
  return typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) ? id : null;
}

/** Classifies one line: the error to answer with, or null when it may be passed to the SDK. */
export function checkLine(line: string): ErrorReply | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return errorReply(null, -32700, "Parse error");
  }
  if (Array.isArray(value)) return errorReply(null, -32600, "Invalid Request: batches are not supported");
  if (!JSONRPCMessageSchema.safeParse(value).success) return errorReply(recoverId(value), -32600, "Invalid Request");
  return null;
}

export function createStdinGuard(reply: (msg: ErrorReply) => void, maxLineBytes = MAX_LINE_BYTES): Transform {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;

  const handleLine = (self: Transform, buf: Buffer): void => {
    const line = buf.toString("utf8").replace(/\r$/, "");
    if (line.trim() === "") return;
    const err = checkLine(line);
    if (err) reply(err);
    else self.push(line + "\n");
  };

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      let start = 0;
      for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, nl);
        start = nl + 1;
        if (discarding) { discarding = false; continue; }
        if (pendingBytes + piece.length > maxLineBytes) {
          pending = []; pendingBytes = 0;
          reply(errorReply(null, -32600, `Invalid Request: message exceeds ${maxLineBytes} bytes`));
          continue;
        }
        handleLine(this, Buffer.concat([...pending, piece]));
        pending = []; pendingBytes = 0;
      }
      const rest = chunk.subarray(start);
      if (!discarding && rest.length > 0) {
        if (pendingBytes + rest.length > maxLineBytes) {
          pending = []; pendingBytes = 0; discarding = true;
          reply(errorReply(null, -32600, `Invalid Request: message exceeds ${maxLineBytes} bytes`));
        } else {
          pending.push(rest); pendingBytes += rest.length;
        }
      }
      done();
    },
    flush(done: TransformCallback) {
      if (!discarding && pendingBytes > 0) handleLine(this, Buffer.concat(pending));
      done();
    },
  });
}
