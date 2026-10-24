// Implements PHASE_8_SPEC.md §6.4
//
// The `doctor` MCP tool: no temp file, no `deps` threading -- `runDoctor(repoRoot, opts)` already
// accepts plain in-memory arguments (`src/cli/doctor.ts`), so this handler calls it directly with
// no indirection, the thinnest possible wrapper this phase produces.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError, UsageError } from "../../domain/errors.ts";
import { DoctorReport, runDoctor } from "../../cli/doctor.ts";

/**
 * Maps 1:1 onto `DoctorOptions` (`src/cli/doctor.ts`) minus `json` -- the tool handler always
 * requests the JSON-shaped report internally (§6.4) and translates it, regardless of what the
 * calling MCP client ultimately renders. Implements PHASE_8_SPEC.md §3.2.
 */
export const DoctorToolInput = z.strictObject({
  /** Absolute or repo-root-relative path to the target repo `doctor` should check. Required -- the
   * MCP server itself has no ambient notion of "the current repo" the way the CLI's own
   * `process.cwd()` does, since an MCP client may drive multiple repos across one server session. */
  repo_dir: z.string().min(1),
  /** Same three-way choice `DoctorOptions.only` already offers; defaults to `"all"`, the same
   * default `doctor` (no flags) already has on the CLI. */
  only: z.enum(["all", "boundary", "providers"]).default("all"),
  /** Make one tiny real call to each provider that passed the static checks, to catch an expired sign-in. Costs seconds and a little of each provider's quota. Not allowed with `only: "boundary"`. */
  live: z.boolean().default(false),
});

/** The inferred type of {@link DoctorToolInput}. */
export type DoctorToolInput = z.infer<typeof DoctorToolInput>;

/** Tool description surfaced in `tools/list`, per PHASE_8_SPEC.md §4.4. */
export const DOCTOR_TOOL_DESCRIPTION =
  "Full health check (or, with only set, boundary scan or provider preflight alone): toolchain, both " +
  "providers, the boundary scan, and a lock smoke test. Equivalent to `osa doctor --json`. A provider's sign-in is " +
  "judged from a saved file unless live is true, which makes one tiny real call to each usable provider and so catches an expired login.";

/**
 * Translates a `DoctorReport` into a successful `CallToolResult`. Pure -- exported for direct unit
 * testing. Implements PHASE_8_SPEC.md §6.4.
 */
export function doctorReportToCallToolResult(report: DoctorReport): CallToolResult {
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
 * Registers the `doctor` tool. No temp file, no `deps` threading -- `runDoctor(repoRoot, opts)`
 * already accepts plain in-memory arguments (`src/cli/doctor.ts`), so this handler calls it
 * directly with no indirection, the thinnest possible wrapper this phase produces. Implements
 * PHASE_8_SPEC.md §6.4.
 */
export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "doctor",
    { description: DOCTOR_TOOL_DESCRIPTION, inputSchema: DoctorToolInput, outputSchema: DoctorReport },
    async (input) => {
      try {
        if (input.live && input.only === "boundary") throw new UsageError("doctor live checks providers, so it cannot be combined with only: \"boundary\".");
        const { report } = await runDoctor(input.repo_dir, { json: true, only: input.only, ...(input.live ? { live: true } : {}) });
        return doctorReportToCallToolResult(report);
      } catch (err) {
        return errorToCallToolResult(err);
      }
    },
  );
}
