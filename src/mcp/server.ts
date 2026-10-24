// Implements PHASE_8_SPEC.md §6.1, §4.1, §4.2
//
// `buildMcpServer()` (pure construction) and `runMcpServer()` (connects a `StdioServerTransport`).
// Only the stdio transport is ever imported here -- never streamableHttp.js/sse.js or any
// @modelcontextprotocol/sdk/client/** subpath (§7 FM-M2, the hard-boundary guard for this phase).

import { closeCodeSearchers } from "./tools/code-search.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { registerRunTool } from "./tools/run.ts";
import { registerDriveTool } from "./tools/drive.ts";
import { registerDoctorTool } from "./tools/doctor.ts";
import { registerEvidenceTool } from "./tools/evidence.ts";
import { registerCodeSearchTool } from "./tools/code-search.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerOsaTools } from "./tools/osa.ts";

/**
 * Constructs an `McpServer` and registers all of OSA's tools on it (the one-shot flow osa_plan / osa_build / osa_status, and run, drive, doctor, evidence, code_search, memory_read, memory_append). Pure construction --
 * performs no I/O and does not connect a transport; `runMcpServer()` is the only caller that does.
 * Exported separately from `runMcpServer()` so a test can register tools and drive `tools/call`
 * requests against the server in-process, without a real stdio transport or child process -- the
 * same "separate pure construction from I/O" discipline `src/cli/doctor.ts`'s own `runDoctor()`/
 * `lockSmokeTest()` split already establishes for a different case. Registers exactly four tools
 * and nothing else -- no `registerResource`/`registerPrompt` call (§7 FM-M6). Implements
 * PHASE_8_SPEC.md §6.1.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "osa", version: pkg.version });
  registerRunTool(server);
  registerDriveTool(server);
  registerDoctorTool(server);
  registerEvidenceTool(server);
  registerCodeSearchTool(server);
  registerMemoryTools(server);
  registerOsaTools(server);
  return server;
}

/**
 * Builds the server (§ above) and attaches a `StdioServerTransport`, reading the current process's
 * own stdin/writing its own stdout. Resolves once `connect()` resolves (the transport has started
 * listening) -- it does not itself block for the life of the session; the Node process stays alive
 * past this function's own return because the transport's active stdin listener keeps the event
 * loop alive, exactly as any long-lived stdio server process already does without an explicit
 * blocking call (§4.2). Never calls `process.exit` -- the same rule every existing command
 * function in this project already follows. Implements PHASE_8_SPEC.md §4.1/§4.2/§6.1.
 */
export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  // A held codebase-memory-mcp session must not keep the process alive after the client goes away.
  server.server.onclose = () => {
    void closeCodeSearchers();
  };
  await server.connect(transport);
}
