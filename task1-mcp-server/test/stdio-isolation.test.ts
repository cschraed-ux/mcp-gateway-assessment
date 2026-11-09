import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = createRequire(import.meta.url).resolve("tsx/cli");

describe("stdio isolation", () => {
  it("emits only JSON-RPC 2.0 messages on stdout and logs to stderr", async () => {
    const child = spawn(process.execPath, [tsxBin, "src/index.ts"], {
      cwd: root, env: { ...process.env, LOG_LEVEL: "debug" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutLines: string[] = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (l) => stdoutLines.push(l));
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "CUST-00001" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "trigger_refund", arguments: { customer_id: "CUST-00001", amount: 5, reason: "secret-reason-text-here" } } });
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "CUST-1" } } });
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "CUST-99999" } } });

    const deadline = Date.now() + 15000;
    const ids = () => stdoutLines.map((l) => (JSON.parse(l) as { id?: number }).id);
    while (![1, 2, 3, 4, 5, 6].every((i) => ids().includes(i))) {
      if (Date.now() > deadline) throw new Error("timeout; stdout=" + stdoutLines.join("\n") + " stderr=" + stderr);
      await new Promise((r) => setTimeout(r, 25));
    }
    const exited = new Promise((r) => child.on("exit", r));
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;

    expect(stdoutLines.length).toBe(6);
    const msgs = stdoutLines.map((l) => JSON.parse(l) as Record<string, any>);
    for (const m of msgs) expect(m["jsonrpc"]).toBe("2.0");
    const byId = (id: number) => msgs.find((m) => m["id"] === id)!;
    expect(byId(2)["result"].tools).toHaveLength(2);
    expect(byId(3)["result"].structuredContent.customer_id).toBe("CUST-00001");
    expect(byId(5)["error"].code).toBe(-32602);
    expect(byId(6)["result"].isError).toBe(true);

    const errLines = stderr.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    expect(errLines.some((l) => l["msg"] === "tool call start" && l["tool"] === "trigger_refund")).toBe(true);
    expect(errLines.some((l) => l["msg"] === "tool call finish")).toBe(true);
    expect(stderr).not.toContain("secret-reason-text-here");
  });

  it("answers malformed lines with JSON-RPC errors instead of dropping them", async () => {
    const child = spawn(process.execPath, [tsxBin, "src/index.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const lines: Record<string, any>[] = [];
    createInterface({ input: child.stdout }).on("line", (l) => lines.push(JSON.parse(l) as Record<string, any>));
    child.stdin.write('{not json\n[]\n{"jsonrpc":"1.0","id":7,"method":"ping"}\n{"jsonrpc":"2.0","id":8,"method":"ping"}\n');
    const deadline = Date.now() + 15000;
    while (lines.length < 4) {
      if (Date.now() > deadline) throw new Error("timeout; stdout=" + JSON.stringify(lines));
      await new Promise((r) => setTimeout(r, 25));
    }
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    await exited;
    for (const m of lines) expect(m["jsonrpc"]).toBe("2.0");
    expect(lines.filter((m) => m["id"] === null).map((m) => m["error"].code).sort((a: number, b: number) => a - b)).toEqual([-32700, -32600]);
    expect(lines.find((m) => m["id"] === 7)?.["error"].code).toBe(-32600);
    expect(lines.find((m) => m["id"] === 8)?.["result"]).toEqual({});
  });
});
