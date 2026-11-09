import { describe, expect, it } from "vitest";
import { checkLine, createStdinGuard, type ErrorReply } from "../src/stdin-guard.js";

function run(chunks: string[], maxLineBytes?: number): Promise<{ passed: string; replies: ErrorReply[] }> {
  const replies: ErrorReply[] = [];
  const guard = createStdinGuard((r) => replies.push(r), maxLineBytes);
  let passed = "";
  guard.on("data", (d: Buffer) => { passed += d.toString(); });
  return new Promise((resolve) => {
    guard.on("end", () => resolve({ passed, replies }));
    for (const c of chunks) guard.write(c);
    guard.end();
  });
}

describe("stdin guard", () => {
  it("answers unparseable JSON with -32700 and id null", () => {
    expect(checkLine("{not json")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });
  it("answers batches and non-objects with -32600 and id null", () => {
    expect(checkLine("[]")?.error.code).toBe(-32600);
    expect(checkLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(checkLine('"just a string"')).toMatchObject({ id: null, error: { code: -32600 } });
  });
  it("answers a bad envelope with -32600 and echoes a recoverable id (including 0 and \"\")", () => {
    expect(checkLine('{"jsonrpc":"1.0","id":6,"method":"ping"}')).toMatchObject({ id: 6, error: { code: -32600 } });
    expect(checkLine('{"jsonrpc":"1.0","id":0,"method":"ping"}')).toMatchObject({ id: 0 });
    expect(checkLine('{"jsonrpc":"1.0","id":"","method":"ping"}')).toMatchObject({ id: "" });
    expect(checkLine('{"jsonrpc":"2.0","id":null,"method":"ping"}')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(checkLine('{"jsonrpc":"2.0","id":1,"method":7}')).toMatchObject({ id: 1, error: { code: -32600 } });
  });
  it("passes valid requests, notifications and responses through", () => {
    expect(checkLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toBeNull();
    expect(checkLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
    expect(checkLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toBeNull();
  });
  it("reassembles lines split across chunks, strips CR and skips blank lines", async () => {
    const r = await run(['{"jsonrpc":"2.0",', '"id":1,"method":"ping"}\r\n\n  \n{bad\n']);
    expect(r.passed).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(r.replies.map((x) => x.error.code)).toEqual([-32700]);
  });
  it("discards an oversized line up to its newline and keeps serving the next one", async () => {
    const r = await run(["x".repeat(40), "y".repeat(40), 'zzz\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'], 64);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]?.error.code).toBe(-32600);
    expect(r.passed).toBe('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  });
  it("rejects an oversized line that arrives complete in one chunk", async () => {
    const r = await run(["a".repeat(100) + '\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n'], 64);
    expect(r.replies).toHaveLength(1);
    expect(r.passed).toBe('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  });
});
