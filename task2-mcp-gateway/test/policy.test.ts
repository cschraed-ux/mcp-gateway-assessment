import { describe, expect, it } from "vitest";
import { authorize, DEFAULT_TOOL_RULES, type ToolRule } from "../src/policy.js";
import type { JsonRpcMessage } from "../src/jsonrpc.js";

const call = (name: unknown, id: number = 1): JsonRpcMessage =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }) as JsonRpcMessage;

describe("authorize", () => {
  it("forwards non tools/call methods for every role", () => {
    for (const method of ["tools/list", "initialize", "ping", "notifications/initialized", "resources/list", "prompts/get"]) {
      expect(authorize({ jsonrpc: "2.0", id: 1, method }, "viewer")).toEqual({ decision: "forward" });
    }
  });

  it("forwards ordinary tools for a viewer", () => {
    expect(authorize(call("get_weather"), "viewer").decision).toBe("forward");
  });

  it("denies admin_ tools for a viewer with -32001 and explanatory data", () => {
    const decision = authorize(call("admin_reset_key"), "viewer");
    expect(decision).toEqual({
      decision: "deny",
      reason: "unauthorized_tool",
      error: {
        code: -32001,
        message: "Unauthorized Tool Call",
        data: { tool: "admin_reset_key", requiredRole: "admin", role: "viewer" },
      },
    });
  });

  it("allows admin_ tools for an admin", () => {
    expect(authorize(call("admin_reset_key"), "admin").decision).toBe("forward");
  });

  it("matches the prefix case-insensitively and ignoring surrounding whitespace", () => {
    expect(authorize(call("Admin_Reset_Key"), "viewer").decision).toBe("deny");
    expect(authorize(call("  admin_delete_user"), "viewer").decision).toBe("deny");
  });

  it("denies tools/call without a usable params.name as invalid params", () => {
    const bad: JsonRpcMessage[] = [
      call(undefined),
      call(42),
      call(""),
      call("   "),
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: ["admin_reset_key"] },
    ];
    for (const message of bad) {
      const decision = authorize(message, "admin");
      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.reason).toBe("invalid_tool_call");
        expect(decision.error.code).toBe(-32602);
      }
    }
  });

  it("applies notifications the same way as requests", () => {
    const note = { jsonrpc: "2.0", method: "tools/call", params: { name: "admin_reset_key" } } as JsonRpcMessage;
    expect(authorize(note, "viewer").decision).toBe("deny");
  });

  it("supports extra rules where every matching rule must allow the role", () => {
    const rules: ToolRule[] = [...DEFAULT_TOOL_RULES, { prefix: "billing_", roles: ["admin"] }, { prefix: "admin_super_", roles: [] }];
    expect(authorize(call("billing_refund"), "viewer", rules).decision).toBe("deny");
    expect(authorize(call("billing_refund"), "admin", rules).decision).toBe("forward");
    expect(authorize(call("admin_super_wipe"), "admin", rules).decision).toBe("deny");
  });

  it("does not mutate the default rule table", () => {
    expect(Object.isFrozen(DEFAULT_TOOL_RULES)).toBe(true);
  });
});
