import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildSpecManifest, changedApprovedSpecFiles, specGateRecordPath, verifyApprovedSpecIntact, verifySpecGate, writeSpecGate } from "./spec-gate.ts";
import { tempGitRepo } from "./fixtures.test.ts";
import { sha256File } from "../util/hash.ts";

async function setupSpec() {
  const repoDir = await tempGitRepo();
  const runId = randomUUID();
  const specDir = `${repoDir}/runs/${runId}/spec`;
  await mkdir(specDir, { recursive: true });

  // Create test spec files.
  await writeFile(`${specDir}/context.md`, "# Context\n\nTest context file.", "utf8");
  await writeFile(`${specDir}/PHASE_1_SPEC.md`, "# Phase 1 Spec\n\nTest phase spec.", "utf8");

  return { repoDir, runId, specDir };
}

test("buildSpecManifest: enumerates all spec files with stable hash", async () => {
  const s = await setupSpec();
  const manifest = await buildSpecManifest(s.repoDir, s.runId);

  // Check that both files are in the manifest.
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.files.some((f) => f.path.includes("context.md")));
  assert.ok(manifest.files.some((f) => f.path.includes("PHASE_1_SPEC.md")));

  // All files should have valid SHA256 hashes.
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }

  // Gate hash should be valid.
  assert.match(manifest.gateHash, /^[0-9a-f]{64}$/);
});

test("buildSpecManifest: same files produce same gate hash", async () => {
  const s = await setupSpec();
  const manifest1 = await buildSpecManifest(s.repoDir, s.runId);
  const manifest2 = await buildSpecManifest(s.repoDir, s.runId);

  assert.equal(manifest1.gateHash, manifest2.gateHash);
});

test("buildSpecManifest: changing a file changes the gate hash", async () => {
  const s = await setupSpec();
  const manifest1 = await buildSpecManifest(s.repoDir, s.runId);

  // Modify a file.
  await writeFile(`${s.specDir}/context.md`, "# Context\n\nModified context file.", "utf8");
  const manifest2 = await buildSpecManifest(s.repoDir, s.runId);

  assert.notEqual(manifest1.gateHash, manifest2.gateHash);
});

test("writeSpecGate and verifySpecGate round-trip", async () => {
  const s = await setupSpec();
  const prdSha256 = "a".repeat(64);

  // Write the spec-gate record.
  const written = await writeSpecGate(s.repoDir, s.runId, prdSha256);
  assert.equal(written.schema_version, 1);
  assert.equal(written.run_id, s.runId);
  assert.equal(written.prd_sha256, prdSha256);

  // Verify it round-trips.
  const verified = await verifySpecGate(s.repoDir, s.runId, prdSha256);
  assert.deepEqual(verified, written);
});

test("verifySpecGate throws when PRD sha256 mismatches", async () => {
  const s = await setupSpec();
  const prdSha256 = "a".repeat(64);
  const wrongSha256 = "b".repeat(64);

  await writeSpecGate(s.repoDir, s.runId, prdSha256);

  // Verify with wrong PRD hash should fail.
  let rejected = false;
  try {
    await verifySpecGate(s.repoDir, s.runId, wrongSha256);
  } catch (err) {
    rejected = true;
    assert.ok(err instanceof Error && (err.message.includes("PRD") || err.message.includes("prd")));
  }
  assert.ok(rejected, "verifySpecGate should have thrown");
});

test("verifySpecGate throws when spec file is tampered", async () => {
  const s = await setupSpec();
  const prdSha256 = "a".repeat(64);

  await writeSpecGate(s.repoDir, s.runId, prdSha256);

  // Tamper with a spec file.
  await writeFile(`${s.specDir}/context.md`, "# Context\n\nTampered context file.", "utf8");

  // Verify should fail.
  let rejected = false;
  try {
    await verifySpecGate(s.repoDir, s.runId, prdSha256);
  } catch (err) {
    rejected = true;
    assert.ok(err instanceof Error && err.message.includes("spec-gate hash"));
  }
  assert.ok(rejected, "verifySpecGate should have thrown");
});

test("specGateRecordPath is correctly formatted", async () => {
  const repoDir = "/repo";
  const runId = "12345678-1234-5678-1234-567812345678";
  const path = specGateRecordPath(repoDir, runId);

  assert.match(path, /\.osa\/runs\/[\da-f-]+\/spec-gate\.json$/);
  assert.ok(path.includes(runId));
});

test("verifyApprovedSpecIntact: later phases' specs added beside the approved files are expected; an approved file edited, removed or a different PRD is not", async () => {
  const s = await setupSpec();
  const prd = "a".repeat(64);
  const record = await writeSpecGate(s.repoDir, s.runId, prd);
  assert.deepEqual(await changedApprovedSpecFiles(s.repoDir, record), []);

  // a build adds the next phase's spec to the same folder: the folder's hash moves, the approved files do not
  await writeFile(`${s.specDir}/PHASE_2_SPEC.md`, "# Phase 2\n", "utf8");
  await assert.rejects(verifySpecGate(s.repoDir, s.runId, prd), /spec-gate hash has changed/, "the whole-folder check is for before the build");
  assert.equal((await verifyApprovedSpecIntact(s.repoDir, s.runId, prd)).spec_gate_sha256, record.spec_gate_sha256);

  await assert.rejects(verifyApprovedSpecIntact(s.repoDir, s.runId, "b".repeat(64)), /locked PRD sha256/);

  await writeFile(`${s.specDir}/PHASE_1_SPEC.md`, "# Phase 1 Spec\n\nEdited.", "utf8");
  await assert.rejects(verifyApprovedSpecIntact(s.repoDir, s.runId, prd), /approved changed since the approval.*PHASE_1_SPEC\.md/s);
  const changed = await changedApprovedSpecFiles(s.repoDir, record);
  assert.equal(changed.length, 1);
  assert.match(changed[0] ?? "", /PHASE_1_SPEC\.md/);
});
