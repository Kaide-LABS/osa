// Implements PHASE_8_SPEC.md §7 FM-M1/FM-M4/FM-M6
//
// buildMcpServer() registers exactly four tools named run/drive/doctor/evidence, each with the
// exact schema object identity named in §3 (not a structurally-similar copy), and no
// resources/prompts primitive (§9 non-goal 6, §7 FM-M6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpServer } from "./server.ts";
import { RunConfig } from "../domain/run.ts";
import { DriveConfig } from "../domain/driver.ts";
import { RunReport } from "../cli/run.ts";
import { DriveReport } from "../cli/drive.ts";
import { DoctorReport } from "../cli/doctor.ts";
import { EvidenceReport } from "../cli/evidence.ts";
import { DoctorToolInput } from "./tools/doctor.ts";
import { EvidenceToolInput } from "./tools/evidence.ts";

/**
 * `McpServer`'s own registered-tool table is a private field (`_registeredTools`) with no public
 * accessor -- there is no `listTools()`/`getRegisteredTools()` method on the class
 * (`dist/esm/server/mcp.d.ts`, read directly during PHASE_8_SPEC.md §8.7's own research pass).
 * Reflecting into it via a minimal, locally-declared structural type (rather than `any`) is the
 * only way to assert registration identity without standing up a full transport round-trip for a
 * purely structural check. Kept narrow and typed, not `unknown`/`any` all the way down.
 */
interface ReflectedTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}
interface ReflectedMcpServer {
  readonly _registeredTools: Readonly<Record<string, ReflectedTool>>;
  readonly _registeredResources: Readonly<Record<string, unknown>>;
  readonly _registeredResourceTemplates: Readonly<Record<string, unknown>>;
  readonly _registeredPrompts: Readonly<Record<string, unknown>>;
}

function reflect(server: ReturnType<typeof buildMcpServer>): ReflectedMcpServer {
  return server as unknown as ReflectedMcpServer;
}

test("buildMcpServer registers exactly the OSA tools: the one-shot flow (osa_plan, osa_build, osa_status), run, drive, doctor, evidence, code_search, memory_read, memory_append, and the global-memory tools memory_save, memory_search", () => {
  const server = buildMcpServer();
  const tools = reflect(server)._registeredTools;
  assert.deepStrictEqual(new Set(Object.keys(tools)), new Set(["osa_plan", "osa_build", "osa_status", "run", "drive", "doctor", "evidence", "code_search", "memory_read", "memory_append", "memory_save", "memory_search"]));
});

test("the run/drive tools' inputSchema/outputSchema is the exact RunConfig/DriveConfig/RunReport/DriveReport object identity", () => {
  const server = buildMcpServer();
  const tools = reflect(server)._registeredTools;
  assert.equal(tools["run"]?.inputSchema, RunConfig);
  assert.equal(tools["run"]?.outputSchema, RunReport);
  assert.equal(tools["drive"]?.inputSchema, DriveConfig);
  assert.equal(tools["drive"]?.outputSchema, DriveReport);
});

test("the doctor/evidence tools' schemas are the exact DoctorToolInput/EvidenceToolInput/DoctorReport/EvidenceReport object identity", () => {
  const server = buildMcpServer();
  const tools = reflect(server)._registeredTools;
  assert.equal(tools["doctor"]?.inputSchema, DoctorToolInput);
  assert.equal(tools["doctor"]?.outputSchema, DoctorReport);
  assert.equal(tools["evidence"]?.inputSchema, EvidenceToolInput);
  assert.equal(tools["evidence"]?.outputSchema, EvidenceReport);
});

test("buildMcpServer registers no resources or prompts (§9 non-goal 6, §7 FM-M6)", () => {
  const server = buildMcpServer();
  const r = reflect(server);
  assert.equal(Object.keys(r._registeredResources).length, 0);
  assert.equal(Object.keys(r._registeredResourceTemplates).length, 0);
  assert.equal(Object.keys(r._registeredPrompts).length, 0);
});
