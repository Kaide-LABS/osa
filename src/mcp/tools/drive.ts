// Implements PHASE_8_SPEC.md §6.3
//
// The `drive` MCP tool: byte-identical shape to src/mcp/tools/run.ts, substituting `DriveConfig`
// for `RunConfig`, `DriveReport`/`runDriveCommand` for `RunReport`/`runRunCommand`, and
// `DriveDispatchDeps` for `RunDispatchDeps`. No orchestration logic of its own -- §6.6/§7 FM-M1.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError } from "../../domain/errors.ts";
import { DriveConfig } from "../../domain/driver.ts";
import type { DriveDispatchDeps } from "../../dispatch/driver-loop.ts";
import { DriveReport, runDriveCommand } from "../../cli/drive.ts";
import { writeTempConfigFile } from "../temp-config.ts";

/** Tool description surfaced in `tools/list`, per PHASE_8_SPEC.md §4.4. */
export const DRIVE_TOOL_DESCRIPTION =
  "Dispatch a target build's own phases sequentially, one runDispatch() call per phase, halting on the " +
  "first ambiguous or incoherent filesystem read. Equivalent to `osa drive --config <path> --json`.";

/**
 * Translates a `DriveReport` into a successful `CallToolResult`. Pure -- exported for direct unit
 * testing, mirroring {@link runReportToCallToolResult}'s own precedent
 * (`src/mcp/tools/run.ts`). `isError` is never set from `report.ok`/`report.exit_code`, for the
 * identical reason `run.ts`'s own doc comment states. Implements PHASE_8_SPEC.md §6.3.
 */
export function driveReportToCallToolResult(report: DriveReport): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    structuredContent: report,
  };
}

/**
 * Translates a thrown error into an error `CallToolResult`. Byte-identical logic to
 * `src/mcp/tools/run.ts`'s own `errorToCallToolResult`, duplicated per-file rather than shared --
 * matching this codebase's own existing per-command-file convention (`src/cli/run.ts`/
 * `src/cli/drive.ts`/`src/cli/evidence.ts` each already define their own report type and
 * translation logic locally rather than sharing a base module).
 */
function errorToCallToolResult(err: unknown): CallToolResult {
  const text =
    err instanceof OsaError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Registers the `drive` tool on `server`. `deps` is threaded straight through to
 * `runDriveCommand`'s own second `deps` argument, mirroring `run.ts`'s own `registerRunTool`.
 * Implements PHASE_8_SPEC.md §6.3.
 */
export function registerDriveTool(server: McpServer, deps?: DriveDispatchDeps): void {
  server.registerTool(
    "drive",
    { description: DRIVE_TOOL_DESCRIPTION, inputSchema: DriveConfig, outputSchema: DriveReport },
    async (config) => {
      const { configPath, cleanup } = await writeTempConfigFile(config);
      try {
        const { report } = await runDriveCommand({ configPath, json: true }, deps);
        return driveReportToCallToolResult(report);
      } catch (err) {
        return errorToCallToolResult(err);
      } finally {
        await cleanup();
      }
    },
  );
}
