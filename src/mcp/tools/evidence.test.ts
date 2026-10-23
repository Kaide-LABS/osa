// Implements PHASE_8_SPEC.md §1.2, §8 criteria 5/6
//
// Same shape as doctor.test.ts, for `evidence`/`EvidenceReport`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EvidenceReport, runEvidenceCommand } from "../../cli/evidence.ts";
import { evidenceReportToCallToolResult, EvidenceToolInput, registerEvidenceTool } from "./evidence.ts";

function syntheticReport(overrides: Partial<EvidenceReport> = {}): EvidenceReport {
  const runId = randomUUID();
  return {
    schema_version: 1,
    generated_at: "2026-08-18T00:00:00.000Z",
    repo_dir: "/tmp/x",
    run_id: runId,
    final_phase: false,
    ok: false,
    exit_code: 13,
    turns_found: 0,
    ac1: { satisfied: false, detail: "no evidence", provider_sequence: [], continuity: [] },
    ac2: { satisfied: false, detail: "no evidence", turn_statuses: [] },
    ac3: { satisfied: false, detail: "no evidence", references: [], production: null },
    problems: ["no evidence"],
    ...overrides,
  };
}

test("evidenceReportToCallToolResult: a report is a non-error result carrying the report verbatim", () => {
  const report = syntheticReport();
  const result = evidenceReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.deepStrictEqual(result.structuredContent, report);
});

test("EvidenceToolInput: rejects an unrecognized field (strict) and a non-uuid run_id, defaults final_phase to false", () => {
  const validRunId = randomUUID();
  assert.equal(EvidenceToolInput.safeParse({ repo_dir: "/tmp/x", run_id: validRunId, extra: 1 }).success, false);
  assert.equal(EvidenceToolInput.safeParse({ repo_dir: "/tmp/x", run_id: "not-a-uuid" }).success, false);
  const parsed = EvidenceToolInput.parse({ repo_dir: "/tmp/x", run_id: validRunId });
  assert.equal(parsed.final_phase, false);
});

function captureEvidenceHandler(): (input: Record<string, unknown>) => Promise<CallToolResult> {
  let handler: ((input: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (input: Record<string, unknown>) => Promise<CallToolResult>) => {
      handler = cb;
    },
  };
  registerEvidenceTool(fakeServer as unknown as Parameters<typeof registerEvidenceTool>[0]);
  if (handler === null) {
    throw new Error("registerEvidenceTool never called server.registerTool");
  }
  return handler;
}

test("evidence MCP tool <-> CLI `evidence --repo-dir <path> --run-id <uuid> --json` equivalence for a run with no persisted evidence", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-mcp-evidence-`);
  const runId = randomUUID();
  try {
    const handler = captureEvidenceHandler();
    const mcpResult = await handler({ repo_dir: dir, run_id: runId, final_phase: false });
    assert.equal(mcpResult.isError, undefined);
    const mcpReport = mcpResult.structuredContent as EvidenceReport;

    const { report: cliReport } = await runEvidenceCommand({ repoDir: dir, runId, finalPhase: false, json: true });

    const strip = (r: EvidenceReport): Omit<EvidenceReport, "generated_at"> => {
      const { generated_at: _generated_at, ...rest } = r;
      return rest;
    };
    assert.deepStrictEqual(strip(mcpReport), strip(cliReport));
    assert.equal(mcpReport.ok, false);
    assert.equal(mcpReport.turns_found, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
