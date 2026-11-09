/**
 * Method-level authorization: a pure function from (JSON-RPC message, role) to a decision.
 *
 * Only `tools/call` is inspected; every other method (`tools/list`, `initialize`, `ping`,
 * `notifications/*`, `resources/*`, `prompts/*`) is forwarded, matching the task statement and
 * because an MCP client must be able to initialize and discover tools. For `tools/call` the
 * policy fails closed: a call without a non-empty string `params.name` is denied with -32602 Invalid
 * params instead of being forwarded for the downstream to interpret. Tool rules are data
 * (`{ prefix, roles }`), so adding a rule is a one-line change. Matching is case-insensitive
 * and ignores surrounding whitespace so `Admin_reset_key` cannot slip past an `admin_` rule if
 * the downstream happens to normalise names; every matching rule must allow the role
 * (the most restrictive rule wins).
 */
import type { Role } from "./auth.js";
import { ErrorCode, errorObject, isPlainObject, type JsonRpcErrorObject, type JsonRpcMessage } from "./jsonrpc.js";

export interface ToolRule {
  /** Tool-name prefix this rule applies to (matched case-insensitively). */
  prefix: string;
  /** Roles allowed to call tools with this prefix. */
  roles: readonly Role[];
}

export const DEFAULT_TOOL_RULES: readonly ToolRule[] = Object.freeze([
  Object.freeze({ prefix: "admin_", roles: Object.freeze(["admin"] as const) }),
]);

export type PolicyDecision =
  | { decision: "forward" }
  | { decision: "deny"; reason: "unauthorized_tool" | "invalid_tool_call"; error: JsonRpcErrorObject };

const FORWARD: PolicyDecision = Object.freeze({ decision: "forward" });

export function authorize(
  message: JsonRpcMessage,
  role: Role,
  rules: readonly ToolRule[] = DEFAULT_TOOL_RULES,
): PolicyDecision {
  if (message.method !== "tools/call") return FORWARD;

  const params = message.params;
  if (!isPlainObject(params) || typeof params.name !== "string" || params.name.trim() === "") {
    return {
      decision: "deny",
      reason: "invalid_tool_call",
      error: errorObject(ErrorCode.InvalidParams, "Invalid params", {
        detail: "tools/call requires params.name to be a non-empty string",
      }),
    };
  }

  const tool = params.name;
  const normalized = tool.trim().toLowerCase();
  for (const rule of rules) {
    if (!normalized.startsWith(rule.prefix.toLowerCase())) continue;
    if (rule.roles.includes(role)) continue;
    return {
      decision: "deny",
      reason: "unauthorized_tool",
      error: errorObject(ErrorCode.UnauthorizedToolCall, "Unauthorized Tool Call", {
        tool,
        requiredRole: rule.roles.length === 1 ? rule.roles[0] : [...rule.roles],
        role,
      }),
    };
  }
  return FORWARD;
}
