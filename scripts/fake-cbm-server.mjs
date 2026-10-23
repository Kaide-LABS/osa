// Test double for codebase-memory-mcp's stdio MCP server. Reads a scenario from the FAKE_CBM_SCENARIO environment variable:
//   { "version": "0.0.0-fake", "initDelayMs": 0, "tools": { "<tool>": <result> | [<result>, ...] }, "dieAfter": <n tool calls> | null }
// where a <result> is { isError?, text?, structured? }. A list is consumed in order (the last entry repeats). Every call is also appended to
// FAKE_CBM_LOG (one JSON line per request) when that variable is set, so tests can assert on what the client asked for.
import { appendFileSync } from "node:fs";

const scenario = JSON.parse(process.env.FAKE_CBM_SCENARIO ?? "{}");
const logPath = process.env.FAKE_CBM_LOG;
const counters = new Map();
let calls = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (logPath) appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\n");
    if (msg.method === "initialize") {
      if (scenario.initDelayMs) await new Promise((r) => setTimeout(r, scenario.initDelayMs));
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "codebase-memory-mcp", version: scenario.version ?? "0.0.0-fake" }, capabilities: { tools: {} } } });
    } else if (msg.method === "tools/call") {
      calls += 1;
      if (scenario.dieAfter != null && calls > scenario.dieAfter) process.exit(3);
      const name = msg.params.name;
      const entry = scenario.tools?.[name];
      if (entry === undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
        continue;
      }
      const n = counters.get(name) ?? 0;
      counters.set(name, n + 1);
      const r = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
      if (r.hang) continue;
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: r.isError === true, content: [{ type: "text", text: r.text ?? JSON.stringify(r.structured ?? {}) }], ...(r.structured !== undefined ? { structuredContent: r.structured } : {}) } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
