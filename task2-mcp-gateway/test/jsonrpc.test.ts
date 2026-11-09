import { describe, expect, it } from "vitest";
import {
  authenticationRequired,
  invalidRequest,
  isBatch,
  isNotification,
  isRequest,
  isResponse,
  parseError,
  parseJson,
  unauthorizedToolCall,
  upstreamUnavailable,
} from "../src/jsonrpc.js";

describe("jsonrpc guards", () => {
  it("accepts requests with string, number, zero and empty-string ids", () => {
    for (const id of ["a", 7, 0, ""]) {
      expect(isRequest({ jsonrpc: "2.0", id, method: "ping" })).toBe(true);
    }
  });

  it("rejects wrong version, missing method, bad params and object ids", () => {
    expect(isRequest({ id: 1, method: "ping" })).toBe(false);
    expect(isRequest({ jsonrpc: "1.0", id: 1, method: "ping" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: 5 })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "x", params: "str" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: { a: 1 }, method: "x" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: Number.NaN, method: "x" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: null, method: "x" })).toBe(false); // MCP forbids null request ids
    expect(isRequest([{ jsonrpc: "2.0", id: 1, method: "x" }])).toBe(false);
  });

  it("treats a message without an id member as a notification", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: null, method: "x" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", method: "x" })).toBe(false);
  });

  it("detects batches and validates response objects", () => {
    expect(isBatch([])).toBe(true);
    expect(isBatch({})).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } })).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", result: 1 })).toBe(false);
  });

  it("builds error responses with the exact codes and id rules", () => {
    expect(parseError()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(invalidRequest().id).toBeNull();
    expect(invalidRequest().error.code).toBe(-32600);
    expect(authenticationRequired().error).toEqual({ code: -32002, message: "Authentication required" });
    expect(unauthorizedToolCall(0).id).toBe(0);
    expect(unauthorizedToolCall("").error).toEqual({ code: -32001, message: "Unauthorized Tool Call" });
    expect(upstreamUnavailable("abc", { requestId: "r" })).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32003, message: "Upstream unavailable", data: { requestId: "r" } },
    });
  });

  it("parses JSON without throwing", () => {
    expect(parseJson("{")).toEqual({ ok: false });
    expect(parseJson("42")).toEqual({ ok: true, value: 42 });
  });
});
