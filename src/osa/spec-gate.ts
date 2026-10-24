// The spec-gate mechanism: a manifest of all spec files with a deterministic hash, written as
// `spec-gate.json` so later runs can resume from the spec without re-running intake/research/spec.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { StageError } from "../domain/errors.ts";
import { sha256File, sha256String } from "../util/hash.ts";
import { osaDir, repoRelToAbs, toRepoRelPosix } from "../util/paths.ts";

/** SHA-256 as lowercase hex (matches the regex already used in lock.ts). */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Persisted at gate time: `.osa/runs/<run-id>/spec-gate.json`. */
export const SpecGateRecord = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.string().uuid(),
  prd_sha256: Sha256Hex,
  spec_gate_sha256: Sha256Hex,
  spec_files: z.array(
    z.strictObject({
      path: z.string().min(1),
      sha256: Sha256Hex,
    })
  ).min(1),
  created_at: z.string().min(1),
});
export type SpecGateRecord = z.infer<typeof SpecGateRecord>;

/** Where the spec-gate record lives. */
export function specGateRecordPath(repoDir: string, runId: string): string {
  return `${osaDir(repoDir)}/runs/${runId}/spec-gate.json`;
}

/** Result of building the spec manifest. */
export interface SpecManifest {
  readonly files: Array<{ readonly path: string; readonly sha256: string }>;
  readonly gateHash: string;
}

/** Builds a stable manifest of all spec files under runs/<id>/spec. */
export async function buildSpecManifest(repoDir: string, runId: string): Promise<SpecManifest> {
  const specDir = repoRelToAbs(repoDir, `runs/${runId}/spec`);
  const files: Array<{ path: string; sha256: string }> = [];

  // Recursively enumerate all files under the spec directory.
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = `${dir}/${entry.name}`;
      const repoRelPath = toRepoRelPosix(repoDir, absPath);
      if (entry.isDirectory()) {
        await walk(absPath, relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const fileHash = await sha256File(absPath);
        files.push({ path: repoRelPath, sha256: fileHash });
      }
    }
  };

  await walk(specDir, "");

  // Sort by path (stable, locale-independent).
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Build manifest string: sorted "<path> <sha256>\n" lines (space-separated).
  // Using a space separator since it cannot appear in paths.
  const manifestString = files.map((f) => `${f.path} ${f.sha256}`).join("\n");

  // The manifest string is hashed as-is (with trailing newline if non-empty).
  const gateHash = sha256String(files.length > 0 ? `${manifestString}\n` : "");

  return { files, gateHash };
}

/** Writes the spec-gate record with the locked PRD's sha256. */
export async function writeSpecGate(repoDir: string, runId: string, prdSha256: string): Promise<SpecGateRecord> {
  const manifest = await buildSpecManifest(repoDir, runId);
  const record: SpecGateRecord = {
    schema_version: 1,
    run_id: runId,
    prd_sha256: prdSha256,
    spec_gate_sha256: manifest.gateHash,
    spec_files: manifest.files,
    created_at: new Date().toISOString(),
  };

  const path = specGateRecordPath(repoDir, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");

  return record;
}

/**
 * Verifies the spec-gate record by recomputing the manifest hash and comparing both hashes.
 * Throws StageError naming which hash failed if either prd_sha256 or spec_gate_sha256 doesn't match.
 */
export async function verifySpecGate(repoDir: string, runId: string, expectedPrdSha256: string): Promise<SpecGateRecord> {
  const path = specGateRecordPath(repoDir, runId);
  let record: SpecGateRecord;

  try {
    record = SpecGateRecord.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    throw new StageError(
      `Failed to read or parse spec-gate.json for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { runId, where: "spec-gate verification" }
    );
  }

  // Recompute the manifest hash.
  const manifest = await buildSpecManifest(repoDir, runId);

  // Check PRD hash.
  if (record.prd_sha256 !== expectedPrdSha256) {
    throw new StageError(
      `The locked PRD sha256 stored in spec-gate.json (${record.prd_sha256}) does not match the expected sha256 (${expectedPrdSha256}). ` +
      "The spec gate is bound to the locked PRD; if the PRD changed, the spec is no longer valid.",
      { runId, expected: expectedPrdSha256, found: record.prd_sha256, field: "prd_sha256" }
    );
  }

  // Check spec-gate hash.
  if (manifest.gateHash !== record.spec_gate_sha256) {
    throw new StageError(
      `The spec-gate hash has changed (expected ${record.spec_gate_sha256}, computed ${manifest.gateHash}). ` +
      "One or more spec files were modified after the gate was written.",
      { runId, expected: record.spec_gate_sha256, found: manifest.gateHash, field: "spec_gate_sha256" }
    );
  }

  return record;
}
