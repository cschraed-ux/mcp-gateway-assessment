import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { CustomerRepository } from "../src/customers.js";

let client: Client;
beforeAll(async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer(new CustomerRepository()).connect(st);
  client = new Client({ name: "test", version: "1" });
  await client.connect(ct);
});
afterAll(async () => { await client.close(); });

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
async function code(p: Promise<unknown>): Promise<number | undefined> {
  try { await p; } catch (e) { if (e instanceof McpError) return e.code; throw e; }
  return undefined;
}
const GOOD = { customer_id: "CUST-00001", amount: 5, reason: "Item arrived damaged" };

describe("tools/list", () => {
  it("lists both tools with annotations and output schemas", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_customer_record", "trigger_refund"]);
    expect(byName["get_customer_record"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["trigger_refund"]?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(byName["trigger_refund"]?.outputSchema).toBeDefined();
    expect(byName["trigger_refund"]?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("get_customer_record", () => {
  it("returns structuredContent for a valid id", async () => {
    const r = await call("get_customer_record", { customer_id: "CUST-00002" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ customer_id: "CUST-00002", name: "Grace Hopper" });
  });
  it("unknown customer is a tool error, not a protocol error", async () => {
    const r = await call("get_customer_record", { customer_id: "CUST-99999" });
    expect(r.isError).toBe(true);
  });

  const bad: [string, unknown][] = [
    ["4 digits", "CUST-1234"], ["6 digits", "CUST-123456"], ["lowercase prefix", "cust-12345"],
    ["trailing letter", "CUST-1234a"], ["leading space", " CUST-12345"], ["trailing newline", "CUST-12345\n"],
    ["empty string", ""], ["number", 12345], ["null", null],
  ];
  it.each(bad)("rejects customer_id (%s) with -32602", async (_n, v) => {
    expect(await code(call("get_customer_record", { customer_id: v as never }))).toBe(-32602);
  });
  it("rejects missing customer_id with -32602", async () => {
    expect(await code(call("get_customer_record", {}))).toBe(-32602);
  });
  it("rejects unknown extra field with -32602", async () => {
    expect(await code(call("get_customer_record", { customer_id: "CUST-00001", extra: 1 }))).toBe(-32602);
  });
});

describe("trigger_refund", () => {
  it("succeeds and returns structuredContent", async () => {
    const r = await call("trigger_refund", GOOD);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ customer_id: "CUST-00001", amount: 5 });
    expect(typeof (r.structuredContent as { refund_id: string }).refund_id).toBe("string");
  });
  it("accepts a 2-decimal amount and the max", async () => {
    expect((await call("trigger_refund", { ...GOOD, customer_id: "CUST-00005", amount: 0.1 })).isError).toBeFalsy();
    expect((await call("trigger_refund", { ...GOOD, customer_id: "CUST-00005", amount: 10000 })).isError).toBeFalsy();
  });
  it("unknown customer returns isError result", async () => {
    const r = await call("trigger_refund", { ...GOOD, customer_id: "CUST-77777" });
    expect(r.isError).toBe(true);
  });
  it("refund over balance returns isError result", async () => {
    const r = await call("trigger_refund", { ...GOOD, customer_id: "CUST-00004" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("exceeds");
  });

  const badAmounts: [string, unknown][] = [
    ["zero", 0], ["negative", -5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
    ["string", "10"], ["3 decimals", 10.123], ["above max", 10000.01], ["null", null],
    ["below one cent (rounds to 0 cents)", 1e-10],
  ];
  it.each(badAmounts)("rejects amount (%s) with -32602", async (_n, v) => {
    expect(await code(call("trigger_refund", { ...GOOD, amount: v as never }))).toBe(-32602);
  });

  it("rejects reason of 9 chars", async () => {
    expect(await code(call("trigger_refund", { ...GOOD, reason: "123456789" }))).toBe(-32602);
  });
  it("rejects 9 chars padded with spaces to 12 (trim rule)", async () => {
    expect(await code(call("trigger_refund", { ...GOOD, reason: "  123456789 " }))).toBe(-32602);
  });
  it("rejects reason over 500 chars", async () => {
    expect(await code(call("trigger_refund", { ...GOOD, reason: "x".repeat(501) }))).toBe(-32602);
  });
  it("rejects missing reason, missing amount, extra field and bad id", async () => {
    expect(await code(call("trigger_refund", { customer_id: "CUST-00001", amount: 5 }))).toBe(-32602);
    expect(await code(call("trigger_refund", { customer_id: "CUST-00001", reason: GOOD.reason }))).toBe(-32602);
    expect(await code(call("trigger_refund", { ...GOOD, extra: true }))).toBe(-32602);
    expect(await code(call("trigger_refund", { ...GOOD, customer_id: "CUST-1234" }))).toBe(-32602);
  });
});

describe("protocol", () => {
  it("unknown tool name yields -32602", async () => {
    expect(await code(call("no_such_tool", {}))).toBe(-32602);
  });
  const raw = (params: unknown) =>
    client.request((params === undefined ? { method: "tools/call" } : { method: "tools/call", params }) as never, CallToolResultSchema);
  it.each([
    ["missing name", { arguments: {} }], ["arguments is an array", { name: "get_customer_record", arguments: ["CUST-00001"] }],
    ["params missing", undefined],
  ])("malformed tools/call params (%s) yield -32602, not -32603", async (_n, params) => {
    expect(await code(raw(params))).toBe(-32602);
  });
});
