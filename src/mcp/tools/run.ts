// Implements PHASE_8_SPEC.md §6.2
//
// The `run` MCP tool: a thin, logic-free translation layer around the existing, unmodified
// `runRunCommand()` (src/cli/run.ts). Validates/translates its input into a `RunConfig` (validated
// by the SDK's own `registerTool` machinery before this handler ever runs, §3.1), writes it to a
// temp config file, calls `runRunCommand()` unmodified, and translates the resulting `RunReport`
// back into a `CallToolResult`. No orchestration logic of its own -- §6.6/§7 FM-M1.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError } from "../../domain/errors.ts";
import { RunConfig } from "../../domain/run.ts";
import type { RunDispatchDeps } from "../../dispatch/run-loop.ts";
import { RunReport, runRunCommand } from "../../cli/run.ts";
import { writeTempConfigFile } from "../temp-config.ts";

/** Tool description surfaced in `tools/list`, per PHASE_8_SPEC.md §4.4. */
export const RUN_TOOL_DESCRIPTION =
  "Dispatch one loopr phase's turn sequence. Equivalent to `osa run --config <path> --json`; " +
  "the config is the tool's own input, not a file the caller must construct on disk. Providers may be " +
  "pinned to a fixed role via the config's role_pins field.";

/**
 * Translates a `RunReport` into a successful (`isError` absent/`false`) `CallToolResult`: a
 * JSON-pretty-printed text block for human/LLM readability plus `structuredContent` carrying the
 * report verbatim, validated against `RunReport` by the SDK's own `validateToolOutput()` (§3.1).
 * Pure -- exported so it is directly unit-testable against a synthetic `RunReport`, the same "test
 * the pure interpretation with a constructed input" precedent `src/cli/main.ts`'s own
 * `renderHumanReport`/`renderRunHumanReport` already establish. Implements PHASE_8_SPEC.md §6.2.
 *
 * `isError` is deliberately never set from `report.ok`/`report.exit_code` -- a `RunReport` with
 * `ok: false` (e.g. a blocked turn, a continuity failure) is a *successful tool call that reports a
 * domain-level outcome*, exactly the distinction `OSA run --json`'s own stdout already
 * makes. See PHASE_8_SPEC.md §6.2's own rationale.
 */
export function runReportToCallToolResult(report: RunReport): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    structuredContent: report,
  };
}

/**
 * Translates a thrown error into an error `CallToolResult`, mirroring `src/cli/main.ts`'s own
 * top-level `catch` discipline (a `OsaError`'s own `message` is surfaced directly; anything
 * else is stringified) but returning a `CallToolResult` rather than a process exit code. Implements
 * PHASE_8_SPEC.md §6.2/§3.3.
 */
export function errorToCallToolResult(err: unknown): CallToolResult {
  const text =
    err instanceof OsaError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Registers the `run` tool on `server`. `deps` is threaded straight through to `runRunCommand`'s
 * own second `deps` argument, mirroring `src/cli/run.ts`'s own `runRunCommand(opts, deps?)`
 * test-seam pass-through one layer up -- `undefined` in real production use (`src/mcp/server.ts`'s
 * own call site never passes it), a fake for tests. Implements PHASE_8_SPEC.md §6.2.
 */
export function registerRunTool(server: McpServer, deps?: RunDispatchDeps): void {
  server.registerTool(
    "run",
    { description: RUN_TOOL_DESCRIPTION, inputSchema: RunConfig, outputSchema: RunReport },
    async (config) => {
      const { configPath, cleanup } = await writeTempConfigFile(config);
      try {
        const { report } = await runRunCommand({ configPath, json: true }, deps);
        return runReportToCallToolResult(report);
      } catch (err) {
        return errorToCallToolResult(err);
      } finally {
        await cleanup();
      }
    },
  );
}
