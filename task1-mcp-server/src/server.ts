/**
 * Builds the McpServer with both tools. Design choice: tools are registered with registerTool
 * (title, description, schemas, annotations drive tools/list), but the tools/call handler is
 * replaced by a thin dispatcher. Reason: SDK 1.32's built-in handler catches every McpError it
 * throws for bad arguments / unknown tools and converts it into a {isError: true} tool result,
 * which would hide malformed input from JSON-RPC clients. The dispatcher validates with the same
 * strict Zod schemas and throws McpError(-32602) so the SDK emits a real JSON-RPC error response.
 * The handler is registered with a loose envelope schema: with the SDK's CallToolRequestSchema a
 * missing `name` or non-object `arguments` failed inside Protocol and came back as -32603.
 * Business failures (unknown customer, insufficient balance) are returned as tool execution
 * errors ({isError: true}) so the model can see and react to them, per the MCP spec.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestParamsSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CustomerRepository } from "./customers.js";
import { logger, redactArgs } from "./logger.js";
import {
  CustomerRecordOutput, GetCustomerRecordInput, RefundOutput, TriggerRefundInput,
  type GetCustomerRecordArgs, type TriggerRefundArgs,
} from "./schemas.js";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

/** Wraps a handler with start/finish/duration logging using redacted args. */
async function logged<A extends Record<string, unknown>>(
  tool: string, args: A, fn: () => CallToolResult,
): Promise<CallToolResult> {
  const start = performance.now();
  logger.info("tool call start", { tool, args: redactArgs(args) });
  const result = fn();
  logger.info("tool call finish", {
    tool, is_error: result.isError === true, duration_ms: Math.round((performance.now() - start) * 1000) / 1000,
  });
  return result;
}

export function createServer(repo: CustomerRepository = new CustomerRepository()): McpServer {
  const server = new McpServer({ name: "task1-mcp-server", version: "1.0.0" });

  const getCustomer = (args: GetCustomerRecordArgs) =>
    logged("get_customer_record", args, () => {
      const c = repo.getCustomer(args.customer_id);
      return c ? ok(c) : toolError(`Customer ${args.customer_id} not found`);
    });
  const refund = (args: TriggerRefundArgs) =>
    logged("trigger_refund", args, () => {
      const r = repo.applyRefund(args.customer_id, args.amount, args.reason);
      return r.ok ? ok(r.refund) : toolError(r.message);
    });

  const handlers = new Map<string, { input: z.ZodType; output: z.ZodType; run: (a: never) => Promise<CallToolResult> }>();

  server.registerTool(
    "get_customer_record",
    {
      title: "Get customer record",
      description: "Look up a customer by ID (CUST-XXXXX, five digits) and return profile, balance and refund history.",
      inputSchema: GetCustomerRecordInput,
      outputSchema: CustomerRecordOutput,
      annotations: { readOnlyHint: true },
    },
    getCustomer,
  );

  server.registerTool(
    "trigger_refund",
    {
      title: "Trigger refund",
      description:
        "Issue a refund to a customer. amount: positive, max 2 decimals, up to the configured maximum. reason: 10-500 characters.",
      inputSchema: TriggerRefundInput,
      outputSchema: RefundOutput,
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    refund,
  );

  handlers.set("get_customer_record", { input: GetCustomerRecordInput, output: CustomerRecordOutput, run: getCustomer as (a: never) => Promise<CallToolResult> });
  handlers.set("trigger_refund", { input: TriggerRefundInput, output: RefundOutput, run: refund as (a: never) => Promise<CallToolResult> });

  // Loose envelope on purpose: Server.setRequestHandler already wraps tools/call handlers with a
  // CallToolRequestSchema check that throws -32602; passing that strict schema here as well would
  // make Protocol parse it first and fail with -32603 instead.
  const CallToolEnvelope = z.object({ method: z.literal("tools/call"), params: z.unknown().optional() });
  server.server.setRequestHandler(CallToolEnvelope, async (request) => {
    const { name, arguments: rawArgs } = CallToolRequestParamsSchema.parse(request.params);
    const tool = handlers.get(name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      logger.warn("invalid params", { tool: name, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}: ${detail}`);
    }
    const result = await tool.run(parsed.data as never);
    if (!result.isError && !tool.output.safeParse(result.structuredContent).success) {
      logger.error("output schema violation", { tool: name });
      throw new McpError(ErrorCode.InternalError, "Internal error");
    }
    return result;
  });

  return server;
}
