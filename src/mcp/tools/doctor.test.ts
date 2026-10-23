// Implements PHASE_8_SPEC.md §1.2, §8 criteria 5/6
//
// doctorReportToCallToolResult() pure-function cases; an integration case asserting the MCP tool's
// output deep-equals `OSA doctor --json`'s own DoctorReport for the same repo (baby_prd
// AC5/AC6).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DoctorReport, runDoctor } from "../../cli/doctor.ts";
import { doctorReportToCallToolResult, DoctorToolInput, registerDoctorTool } from "./doctor.ts";

function syntheticReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    schema_version: 1,
    generated_at: "2026-08-18T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    toolchain: { node: { found: true, version: "24.15.0", inRange: true }, git: { found: true, version: "2.54.0", inRange: true } },
    providers: [],
    boundary: { filesScanned: 0, violations: [] },
    lock: { acquirable: true, detail: "ok" },
    problems: [],
    ...overrides,
  };
}

test("doctorReportToCallToolResult: an ok report is a non-error result carrying the report verbatim", () => {
  const report = syntheticReport();
  const result = doctorReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.deepStrictEqual(result.structuredContent, report);
});

test("DoctorToolInput: rejects an unrecognized field (strict) and defaults `only` to 'all'", () => {
  const rejected = DoctorToolInput.safeParse({ repo_dir: "/tmp/x", extra_unknown_field: 1 });
  assert.equal(rejected.success, false);

  const parsed = DoctorToolInput.parse({ repo_dir: "/tmp/x" });
  assert.equal(parsed.only, "all");
});

function captureDoctorHandler(): (input: Record<string, unknown>) => Promise<CallToolResult> {
  let handler: ((input: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (input: Record<string, unknown>) => Promise<CallToolResult>) => {
      handler = cb;
    },
  };
  registerDoctorTool(fakeServer as unknown as Parameters<typeof registerDoctorTool>[0]);
  if (handler === null) {
    throw new Error("registerDoctorTool never called server.registerTool");
  }
  return handler;
}

test("doctor MCP tool <-> CLI `doctor --boundary --json` equivalence for this repo (baby_prd AC5/AC6)", async () => {
  const handler = captureDoctorHandler();
  const mcpResult = await handler({ repo_dir: process.cwd(), only: "boundary" });
  assert.equal(mcpResult.isError, undefined);
  const mcpReport = mcpResult.structuredContent as DoctorReport;

  const { report: cliReport } = await runDoctor(process.cwd(), { json: true, only: "boundary" });

  const strip = (r: DoctorReport): Omit<DoctorReport, "generated_at"> => {
    const { generated_at: _generated_at, ...rest } = r;
    return rest;
  };
  assert.deepStrictEqual(strip(mcpReport), strip(cliReport));
  // This repo's own boundary scan must stay clean after the MCP layer is added (§7 FM-M3, AC5).
  assert.equal(mcpReport.exit_code, 0);
  assert.deepStrictEqual(mcpReport.boundary.violations, []);
});
