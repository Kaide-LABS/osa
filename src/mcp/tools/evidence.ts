// Implements PHASE_8_SPEC.md §6.5
//
// The `evidence` MCP tool: byte-identical shape to src/mcp/tools/doctor.ts, substituting
// `EvidenceToolInput`/`EvidenceReport`/`runEvidenceCommand` for their `doctor` counterparts. No
// temp file, no `deps` threading -- `EvidenceCommandOptions` is already a plain in-memory shape.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError } from "../../domain/errors.ts";
import { EvidenceReport, runEvidenceCommand } from "../../cli/evidence.ts";

/**
 * Maps 1:1 onto `EvidenceCommandOptions` (`src/cli/evidence.ts`) minus `json`, same treatment as
 * {@link DoctorToolInput} (`src/mcp/tools/doctor.ts`). Implements PHASE_8_SPEC.md §3.2.
 */
export const EvidenceToolInput = z.strictObject({
  repo_dir: z.string().min(1),
  run_id: z.uuid(),
  /** Same default `EvidenceCommandOptions.finalPhase`'s own CLI flag (`--final-phase`, absent =
   * `false`) already has. */
  final_phase: z.boolean().default(false),
});

/** The inferred type of {@link EvidenceToolInput}. */
export type EvidenceToolInput = z.infer<typeof EvidenceToolInput>;

/** Tool description surfaced in `tools/list`, per PHASE_8_SPEC.md §4.4. */
export const EVIDENCE_TOOL_DESCRIPTION =
  "Re-derive AC1/AC2/AC3 evidence for a completed run from its persisted handoff records. Equivalent to " +
  "`osa evidence --repo-dir <path> --run-id <uuid> [--final-phase] --json`.";

/**
 * Translates an `EvidenceReport` into a successful `CallToolResult`. Pure -- exported for direct
 * unit testing. Implements PHASE_8_SPEC.md §6.5.
 */
export function evidenceReportToCallToolResult(report: EvidenceReport): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    structuredContent: report,
  };
}

/**
 * Translates a thrown error into an error `CallToolResult`. Byte-identical logic to
 * `src/mcp/tools/run.ts`'s own `errorToCallToolResult`, duplicated per-file per this codebase's own
 * existing per-command-file convention.
 */
function errorToCallToolResult(err: unknown): CallToolResult {
  const text =
    err instanceof OsaError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Registers the `evidence` tool. No temp file, no `deps` threading -- `EvidenceCommandOptions` is
 * already a plain in-memory shape, so this handler calls `runEvidenceCommand` directly with no
 * indirection. Implements PHASE_8_SPEC.md §6.5.
 */
export function registerEvidenceTool(server: McpServer): void {
  server.registerTool(
    "evidence",
    { description: EVIDENCE_TOOL_DESCRIPTION, inputSchema: EvidenceToolInput, outputSchema: EvidenceReport },
    async (input) => {
      try {
        const { report } = await runEvidenceCommand({
          repoDir: input.repo_dir,
          runId: input.run_id,
          finalPhase: input.final_phase,
          json: true,
        });
        return evidenceReportToCallToolResult(report);
      } catch (err) {
        return errorToCallToolResult(err);
      }
    },
  );
}
