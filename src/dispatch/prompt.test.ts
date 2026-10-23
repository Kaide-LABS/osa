// Implements PHASE_3_SPEC.md §1.1 -- prompt.test.ts
// Covers §8 acceptance criteria #25, #26.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_RELAY_KEY_PATTERN, RELAY_SCHEMA_VERSION } from "../domain/relay.ts";
import type { HandoffRecord } from "../domain/relay.ts";
import { getRole } from "../domain/roles.ts";
import { PROVIDER_IDS } from "../domain/run.ts";
import { MODEL_TIERS } from "../domain/tiers.ts";
import {
  buildArtifactProductionInstructions,
  buildExecutorPrompt,
  buildHandoffContext,
  buildProtocolInstructions,
  buildReviewerPrompt,
  sanitizeProjectRolePrompt,
} from "./prompt.ts";

const HANDOFF_RECORD_FIELD_NAMES = [
  "schema_version",
  "run_id",
  "phase",
  "turn_index",
  "role",
  "provider",
  "model_tier",
  "started_at",
  "completed_at",
  "repo",
  "spec_ref",
  "artifacts_read",
  "artifacts_written",
  "status",
  "work_done",
  "next_steps",
  "open_questions",
  "halt",
];

function priorRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    schema_version: 1,
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turn_index: 0,
    role: "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: { branch: "main", head_before: "a".repeat(40), head_after: "b".repeat(40), commits: ["b".repeat(40)] },
    spec_ref: { path: "PHASE_1_SPEC.md", sha256: "c".repeat(64) },
    artifacts_read: [],
    artifacts_written: [{ path: "src/foo.ts", sha256: "d".repeat(64) }],
    status: "completed",
    work_done: "Implemented foo.",
    next_steps: ["Implement bar."],
    open_questions: ["Should bar be async?"],
    halt: null,
    ...overrides,
  };
}

test("buildProtocolInstructions contains every mandatory-content item, tested individually", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json",
    role: "executor",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // 1. the literal handoffAbsPath
  assert.ok(out.includes("/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json"));
  // 2. every one of the eighteen HandoffRecord top-level field names
  for (const field of HANDOFF_RECORD_FIELD_NAMES) {
    assert.ok(out.includes(field), `expected protocol instructions to mention field "${field}"`);
  }
  // 3. factual-only statement citing PRD §6.4 by name
  assert.ok(out.includes("factual"));
  assert.ok(out.includes("PRD §6.4"));
  // 4. advisory-only / overwritten statement
  assert.ok(out.includes("advisory only"));
  assert.ok(out.includes("overwrites"));
  // 5. honest-halt statement
  assert.ok(out.includes('"blocked"'));
  assert.ok(out.includes('"halted"'));
  assert.ok(out.includes('"completed"'));
  // 6. the literal specRepoRelPath
  assert.ok(out.includes("PHASE_2_SPEC.md"));
  // 7. the literal babyPrdRepoRelPath (PHASE_4_SPEC.md §6.2, new)
  assert.ok(out.includes(".claude/loopr/baby_prd.md"));
  // 8. the literal contextRepoRelPath (PHASE_4_SPEC.md §6.2, new)
  assert.ok(out.includes(".claude/loopr/context.md"));
});

test("buildProtocolInstructions tells the turn to record every one of the three required loopr artifacts -- the phase spec included -- in artifacts_read", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json",
    role: "executor",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // Regression: a live dispatched turn genuinely read all three artifacts, but recorded only
  // baby_prd.md and context.md in artifacts_read -- the two whose sentences asked for it. The
  // phase-spec sentence said only "read it and do the work", so assertLooprArtifactsReferenced()
  // (PRD §2 AC3) refused the turn on the missing spec_path. Every "read this artifact" instruction
  // must now carry the recording requirement, checked the same way for all three.
  for (const artifactPath of ["PHASE_2_SPEC.md", ".claude/loopr/baby_prd.md", ".claude/loopr/context.md"]) {
    const instruction = out
      .split("\n")
      .find((line) => line.startsWith("Read ") && line.includes(`"${artifactPath}"`));
    assert.ok(instruction !== undefined, `expected a "Read ..." instruction naming "${artifactPath}"`);
    assert.ok(
      instruction.includes("record it in artifacts_read"),
      `expected the "Read ..." instruction for "${artifactPath}" to require recording it in artifacts_read, got: ${instruction}`,
    );
  }

  // The phase spec's own sentence still carries the do-the-work mandate it always had.
  assert.ok(out.includes('Read the phase spec at repo-relative path "PHASE_2_SPEC.md", do the work it describes, and record it in artifacts_read.'));
});

test("buildProtocolInstructions states schema_version's exact value shape: the bare integer, never a version string", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json",
    role: "executor",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // Regression: a live dispatched turn wrote `"schema_version": "1.0"` -- a plausible semver-style
  // string -- because the prompt listed the field by name only. The prompt must now state the
  // required literal, and must name the wrong-but-plausible forms explicitly.
  assert.equal(RELAY_SCHEMA_VERSION, 1);
  assert.ok(out.includes(`- schema_version: the bare JSON integer ${String(RELAY_SCHEMA_VERSION)}`));
  assert.ok(out.includes("no quotes, no decimal point"));
  assert.ok(out.includes("not a semver string"));
  assert.ok(out.includes('"1.0"'));
  assert.ok(out.includes(`the quoted string "${String(RELAY_SCHEMA_VERSION)}" are all rejected outright`));
});

test("buildProtocolInstructions annotates every HandoffRecord field with a value shape, not just a name", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json",
    role: "reviewer",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // Every one of the eighteen fields appears as an annotated bullet with a non-empty description,
  // never as a bare name in a comma-joined list.
  for (const field of HANDOFF_RECORD_FIELD_NAMES) {
    const match = new RegExp(`^- (?:[a-z_]+, )*${field}(?:, [a-z_]+)*: \\S`, "m").exec(out);
    assert.ok(match !== null, `expected an annotated value-shape line for field "${field}"`);
  }

  // The enum-valued fields show their literal admissible values, taken from the canonical schemas.
  for (const provider of PROVIDER_IDS) {
    assert.ok(out.includes(`"${provider}"`), `expected provider value "${provider}" to be shown`);
  }
  for (const tier of MODEL_TIERS) {
    assert.ok(out.includes(`"${tier}"`), `expected model_tier value "${tier}" to be shown`);
  }
  assert.ok(out.includes('- status: exactly one of "completed", "blocked", "halted".'));
  // The plain-number fields say "bare integer" rather than leaving quoting to guesswork.
  assert.ok(out.includes("- phase: a bare integer >= 1 (no quotes)."));
  assert.ok(out.includes("- turn_index: a bare integer >= 0 (no quotes)."));
  // role is stated concretely for the turn being dispatched.
  assert.ok(out.includes('For this turn it is "reviewer".'));
});

test("buildProtocolInstructions requires the turn to really perform a git commit, in terms that cannot be read as optional", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/.osa/runs/abc/handoff/1/000-executor-claude-code.json",
    role: "executor",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // Regression: a live dispatched turn did the phase's real work and reported status "completed"
  // without ever running git add/git commit -- a plausible reading of the advisory-fields note as
  // "git is optional". Ground-truth reconciliation refused it on R3. The prompt must state the
  // action as mandatory, in its own right, and name R3's consequence in plain language.
  const commitMandate = out.split("\n").filter((line) => /\bmust\b/.test(line) && /\bcommit\b/.test(line));
  assert.ok(commitMandate.length >= 1, "expected at least one line stating the commit as a must");
  assert.ok(out.includes("You must commit your work to git before your turn ends."));
  assert.ok(out.includes("git add"));
  assert.ok(out.includes("git commit"));
  assert.ok(out.includes("at least one new commit"));
  // R3's actual consequence, stated as a mechanical refusal rather than a schema detail.
  assert.ok(out.includes("mechanically refuses the entire turn"));
  assert.ok(out.includes('status: "completed" with no new commit'));
  // Uncommitted work is explicitly disqualified -- the exact state the live turn ended in.
  assert.ok(out.includes("Work left uncommitted in the working tree does not count"));
});

test("buildProtocolInstructions keeps the commit requirement separate from, and bounds, the advisory-fields note", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/handoff.json",
    role: "executor",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });
  const lines = out.split("\n");

  const advisoryIndex = lines.findIndex((line) => line.includes("advisory only"));
  const mandateIndex = lines.findIndex((line) => line.includes("You must commit your work to git"));
  assert.ok(advisoryIndex >= 0);
  assert.ok(mandateIndex >= 0);
  // Two distinct statements, not one blended sentence, and the mandate is stated first so the
  // advisory note reads as a bounded exception to it rather than as a licence.
  assert.notEqual(advisoryIndex, mandateIndex);
  assert.ok(mandateIndex < advisoryIndex);

  // The advisory statement bounds itself in place: it is about those two fields' values only.
  const advisoryLine = lines[advisoryIndex] ?? "";
  assert.ok(advisoryLine.includes("does not make committing optional"));
  assert.ok(advisoryLine.includes("accuracy of those two fields' values"));
});

test("buildProtocolInstructions pairs the commit requirement with the neutral-commit-message constraint (I4)", () => {
  const out = buildProtocolInstructions({
    handoffAbsPath: "/repo/handoff.json",
    role: "reviewer",
    specRepoRelPath: "PHASE_2_SPEC.md",
    babyPrdRepoRelPath: ".claude/loopr/baby_prd.md",
    contextRepoRelPath: ".claude/loopr/context.md",
  });

  // Now that every turn is told to commit, an attribution trailer in that commit would be a hard
  // BoundaryViolationError with no retry -- strictly worse than the retryable R3 refusal it
  // replaces. The prompt states the constraint alongside the requirement.
  assert.ok(out.includes("Keep the commit message neutral and factual"));
  assert.ok(out.includes("AI-attribution or model-generation trailer"));
  assert.ok(out.includes("fails the whole run outright as a boundary violation"));
});

test("buildHandoffContext renders only the allow-listed fields, never a raw JSON dump", () => {
  const out = buildHandoffContext(priorRecord());
  assert.ok(out.includes("Implemented foo."));
  assert.ok(out.includes("Implement bar."));
  assert.ok(out.includes("Should bar be async?"));
  assert.ok(out.includes("src/foo.ts"));
  assert.ok(out.includes("completed"));
  assert.ok(out.includes("PHASE_1_SPEC.md"));
  // Not a raw JSON dump: schema_version/run_id/turn_index/role/provider/model_tier/started_at/
  // completed_at/repo (git ground truth)/artifacts_read are not allow-listed and must not leak.
  assert.ok(!out.includes("schema_version"));
  assert.ok(!out.includes("run_id"));
  assert.ok(!out.includes("model_tier"));
});

const BABY_PRD_REPO_REL_PATH = ".claude/loopr/baby_prd.md";
const CONTEXT_REPO_REL_PATH = ".claude/loopr/context.md";

test("buildHandoffContext tells the receiving turn to read the prior turn's artifacts back and record them in artifacts_read", () => {
  // Regression: a live cross-provider handoff (Claude Code turn 0 wrote wordcount.mjs and
  // wordcount.test.mjs; Codex CLI turn 1 demonstrably read and extended both) was refused as
  // IGNORED (failed: C5_ARTIFACT_ATTESTATION), twice, because the receiving turn's artifacts_read
  // listed only the three loopr artifacts. artifacts_written was rendered as informational context
  // and nothing ever stated the required action. checkC5ArtifactAttestation() (PRD §2 AC1/AC3) is
  // the mechanical proof of genuine continuation, so the prompt must ask for exactly what it reads.
  const out = buildHandoffContext(
    priorRecord({
      artifacts_written: [
        { path: "wordcount.mjs", sha256: "e".repeat(64) },
        { path: "wordcount.test.mjs", sha256: "f".repeat(64) },
      ],
    }),
  );

  // The paths themselves are still rendered, as they always were.
  assert.ok(out.includes("  - wordcount.mjs (sha256 " + "e".repeat(64) + ")"));
  assert.ok(out.includes("  - wordcount.test.mjs (sha256 " + "f".repeat(64) + ")"));

  // ...and now the action they imply is stated outright, as a must, naming artifacts_read.
  const mandate = out
    .split("\n")
    .filter((line) => /\bmust\b/.test(line) && line.includes("artifacts_read"));
  assert.ok(mandate.length >= 1, "expected at least one line stating the artifacts_read recording as a must");
  assert.ok(out.includes("You must genuinely open and read every file listed under artifacts_written above"));
  assert.ok(out.includes("record every one of those paths, with its SHA-256, in your own record's artifacts_read array"));
  // C5's actual consequence, in plain language rather than as a check id.
  assert.ok(out.includes("every artifact the prior turn wrote was genuinely read back by this turn"));
  assert.ok(out.includes("refuses the entire turn"));
  // The exact failure mode observed live: read the file, said so in work_done, never listed it.
  assert.ok(out.includes("the path has to be in artifacts_read"));

  // The instruction appears after the list it refers to, so "listed above" actually resolves.
  const lines = out.split("\n");
  const lastArtifactIndex = lines.findIndex((line) => line.includes("wordcount.test.mjs (sha256"));
  const instructionIndex = lines.findIndex((line) => line.includes("You must genuinely open and read every file"));
  assert.ok(lastArtifactIndex >= 0);
  assert.ok(instructionIndex > lastArtifactIndex);
});

test("the read-back instruction is omitted when the prior turn wrote nothing, and absent entirely from a first turn", () => {
  // Nothing to read back: the instruction would be pure noise, and C5 is vacuously satisfied.
  const empty = buildHandoffContext(priorRecord({ artifacts_written: [] }));
  assert.ok(!empty.includes("artifacts_read"));
  assert.ok(!empty.includes("You must genuinely open and read every file"));

  // A first executor turn (priorRecord: null) never gets buildHandoffContext at all, so it never
  // sees a read-back instruction for artifacts that do not exist.
  const first = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
  });
  assert.ok(!first.includes("You must genuinely open and read every file listed under artifacts_written above"));
  assert.ok(!first.includes("every artifact the prior turn wrote was genuinely read back by this turn"));
});

test("both C5-subject turns receive the read-back instruction -- the second executor turn and the reviewer alike", () => {
  // verifyContinuation() runs over every consecutive pair, executor->reviewer included
  // (src/dispatch/run-loop.ts), so the reviewer is bound by C5 identically. buildHandoffContext is
  // shared by both prompt builders, so one placement covers both paths.
  const second = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    retryNote: null,
  });
  const reviewer = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });

  for (const out of [second, reviewer]) {
    assert.ok(out.includes("You must genuinely open and read every file listed under artifacts_written above"));
    assert.ok(out.includes("record every one of those paths, with its SHA-256, in your own record's artifacts_read array"));
    assert.ok(out.includes("refuses the entire turn"));
    // And the prior turn's real artifact path is right there above it.
    assert.ok(out.includes("src/foo.ts"));
  }
});

test("both dispatched roles receive the commit requirement -- buildProtocolInstructions is shared, so one statement binds executor and reviewer alike", () => {
  const executorOut = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
  });
  const reviewerOut = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });

  for (const out of [executorOut, reviewerOut]) {
    assert.ok(out.includes("You must commit your work to git before your turn ends."));
    assert.ok(out.includes("mechanically refuses the entire turn"));
    assert.ok(out.includes("Keep the commit message neutral and factual"));
  }

  // And the reviewer is told, at the point it is handed its own artifact path, that the artifact
  // itself belongs in that commit -- the one file a reviewer turn is most likely to leave untracked.
  assert.ok(reviewerOut.includes('Commit "PHASE_2_SPEC.md", along with every other file you changed this turn'));
  assert.ok(buildArtifactProductionInstructions("PHASE_5_SPEC.md", false).includes('Commit "PHASE_5_SPEC.md"'));
});

test("buildExecutorPrompt omits handoff context on the first turn (priorRecord: null) and includes it on the second", () => {
  const first = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
  });
  assert.ok(!first.includes("Implemented foo."));

  const second = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    retryNote: null,
  });
  assert.ok(second.includes("Implemented foo."));
});

test("buildExecutorPrompt appends retryNote when non-null", () => {
  const out = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: "RETRY: fix C3_NO_REVERT.",
  });
  assert.ok(out.includes("RETRY: fix C3_NO_REVERT."));
});

test("buildReviewerPrompt contains the spec path, the real diff text, and the prior record's allow-listed fields, and introduces no forbidden key name", () => {
  const diff = "diff --git a/foo.ts b/foo.ts\n+added a line\n";
  const out = buildReviewerPrompt({
    specRepoRelPath: "PHASE_2_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff,
    expectedArtifactPath: "PHASE_3_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });
  assert.ok(out.includes("PHASE_2_SPEC.md"));
  assert.ok(out.includes(diff));
  assert.ok(out.includes("Implemented foo."));

  // buildHandoffContext's own "key: value" style labels never introduce a forbidden key name.
  // (Its own protocol-instruction prose legitimately *mentions* "reasoning"/"transcript" etc. as
  // English words while explaining the isolation rule to the agent -- that is not the same as
  // introducing one of those names as a payload key, which is what §6.2 item 26 actually guards
  // against. The allow-listed field *values* themselves came from an already-validated
  // HandoffRecord, which cannot contain such a key by construction -- assertNoTranscriptFields
  // already rejected it before this record was ever accepted.)
  const contextOnly = buildHandoffContext(priorRecord());
  const keyLabels = [...contextOnly.matchAll(/^([a-zA-Z_]+):/gm)].map((m) => m[1] ?? "");
  for (const label of keyLabels) {
    assert.equal(FORBIDDEN_RELAY_KEY_PATTERN.test(label), false, `key label "${label}" must not match the isolation denylist`);
  }
});

test("buildReviewerPrompt truncates a very large diff rather than embedding it unboundedly", () => {
  const hugeDiff = "x".repeat(50_000);
  const out = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: hugeDiff,
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });
  assert.ok(out.length < hugeDiff.length);
  assert.ok(out.includes("truncated"));
});

test("buildReviewerPrompt appends retryNote when non-null", () => {
  const out = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: "RETRY: address C4_SPEC_CONTINUITY.",
  });
  assert.ok(out.includes("RETRY: address C4_SPEC_CONTINUITY."));
});

// -------------------------------------------------------------------------------------------
// PHASE_4_SPEC.md §6.2 -- buildArtifactProductionInstructions() and its reviewer-only wiring
// (§8 acceptance criteria #25, #26)
// -------------------------------------------------------------------------------------------

test("buildArtifactProductionInstructions contains the literal expectedArtifactPath and branches on isFinalPhase", () => {
  const nonFinal = buildArtifactProductionInstructions("PHASE_5_SPEC.md", false);
  assert.ok(nonFinal.includes("PHASE_5_SPEC.md"));
  assert.ok(nonFinal.includes("technical blueprint"));
  assert.ok(!nonFinal.includes("completion record"));

  const final = buildArtifactProductionInstructions("BUILD_COMPLETE.md", true);
  assert.ok(final.includes("BUILD_COMPLETE.md"));
  assert.ok(final.includes("completion record"));
  assert.ok(!final.includes("technical blueprint"));
});

test("buildReviewerPrompt's output contains the literal expectedArtifactPath and the isFinalPhase-branched framing, for both branches", () => {
  const nonFinal = buildReviewerPrompt({
    specRepoRelPath: "PHASE_4_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_5_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });
  assert.ok(nonFinal.includes("PHASE_5_SPEC.md"));
  assert.ok(nonFinal.includes("technical blueprint"));

  const final = buildReviewerPrompt({
    specRepoRelPath: "PHASE_5_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "BUILD_COMPLETE.md",
    isFinalPhase: true,
    retryNote: null,
  });
  assert.ok(final.includes("BUILD_COMPLETE.md"));
  assert.ok(final.includes("completion record"));
});

// -------------------------------------------------------------------------------------------
// sanitizeProjectRolePrompt() and its roleTaskInstructions wiring into buildExecutorPrompt()/
// buildReviewerPrompt() -- dispatching a target build's own customized loopr Step 11/12 prompt
// (RunConfig.executor_prompt_path/reviewer_prompt_path) across either provider.
// -------------------------------------------------------------------------------------------

const LOOPR_STEP11_FIXTURE = [
  "---",
  "name: loopr-step11",
  "description: Runs this project's customized step11 prompt.",
  "model: sonnet",
  "effort: low",
  "---",
  "",
  "STEP 11 PROMPT",
  "# STEP 11 -- PHASE BUILD EXECUTION -- some-project",
  "",
  "Run in Claude Code. Working directory: some-project root.",
  "",
  "## ROLE",
  "Act as the Lead Execution Engineer for some-project.",
].join("\n");

test("sanitizeProjectRolePrompt strips a leading YAML frontmatter block and preserves the body verbatim", () => {
  const out = sanitizeProjectRolePrompt(LOOPR_STEP11_FIXTURE);
  assert.ok(!out.includes("name: loopr-step11"));
  assert.ok(!out.includes("model: sonnet"));
  assert.ok(!out.includes("effort: low"));
  assert.ok(out.includes("# STEP 11 -- PHASE BUILD EXECUTION -- some-project"));
  assert.ok(out.includes("Act as the Lead Execution Engineer for some-project."));
});

test("sanitizeProjectRolePrompt neutralizes single-provider environment phrasing with a notice, rather than editing the body", () => {
  const out = sanitizeProjectRolePrompt(LOOPR_STEP11_FIXTURE);
  // The body's own "Run in Claude Code" line is left completely intact -- the fix is a notice
  // ahead of it, not surgery on the customized content itself.
  assert.ok(out.includes("Run in Claude Code. Working directory: some-project root."));
  assert.ok(out.includes("not a constraint on this dispatch"));
  assert.ok(out.includes("OSA's own protocol instructions"));
  // The notice appears before the body, so it frames the reader's expectations up front.
  const noticeIndex = out.indexOf("not a constraint on this dispatch");
  const bodyIndex = out.indexOf("# STEP 11 -- PHASE BUILD EXECUTION");
  assert.ok(noticeIndex >= 0 && bodyIndex >= 0 && noticeIndex < bodyIndex);
});

test("sanitizeProjectRolePrompt leaves content with no frontmatter block untouched aside from the prepended notice", () => {
  const noFrontmatter = "## ROLE\nAct as reviewer.";
  const out = sanitizeProjectRolePrompt(noFrontmatter);
  assert.ok(out.includes("## ROLE\nAct as reviewer."));
  assert.ok(out.includes("not a constraint on this dispatch"));
});

test("buildExecutorPrompt places roleTaskInstructions after the role profile and before the protocol instructions, and omits it entirely when absent", () => {
  const withInstructions = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
    roleTaskInstructions: "CUSTOM STEP 11 METHODOLOGY MARKER",
  });
  assert.ok(withInstructions.includes("CUSTOM STEP 11 METHODOLOGY MARKER"));
  const profileIndex = withInstructions.indexOf(getRole("executor").profileSummary);
  const instructionsIndex = withInstructions.indexOf("CUSTOM STEP 11 METHODOLOGY MARKER");
  const protocolIndex = withInstructions.indexOf("You are participating in an OSA dispatched");
  assert.ok(profileIndex >= 0 && instructionsIndex >= 0 && protocolIndex >= 0);
  assert.ok(profileIndex < instructionsIndex);
  assert.ok(instructionsIndex < protocolIndex);

  const withoutField = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
  });
  assert.ok(!withoutField.includes("CUSTOM STEP 11 METHODOLOGY MARKER"));

  const withNull = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: null,
    retryNote: null,
    roleTaskInstructions: null,
  });
  assert.equal(withNull, withoutField);
});

test("buildReviewerPrompt places roleTaskInstructions after the role profile and before the protocol instructions, and omits it entirely when absent", () => {
  const withInstructions = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
    roleTaskInstructions: "CUSTOM STEP 12 METHODOLOGY MARKER",
  });
  assert.ok(withInstructions.includes("CUSTOM STEP 12 METHODOLOGY MARKER"));
  const profileIndex = withInstructions.indexOf(getRole("reviewer").profileSummary);
  const instructionsIndex = withInstructions.indexOf("CUSTOM STEP 12 METHODOLOGY MARKER");
  const protocolIndex = withInstructions.indexOf("You are participating in an OSA dispatched");
  assert.ok(profileIndex >= 0 && instructionsIndex >= 0 && protocolIndex >= 0);
  assert.ok(profileIndex < instructionsIndex);
  assert.ok(instructionsIndex < protocolIndex);

  const withoutField = buildReviewerPrompt({
    specRepoRelPath: "PHASE_1_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath: "PHASE_2_SPEC.md",
    isFinalPhase: false,
    retryNote: null,
  });
  assert.ok(!withoutField.includes("CUSTOM STEP 12 METHODOLOGY MARKER"));
});

test("buildExecutorPrompt's output never contains buildArtifactProductionInstructions()'s output -- production instructions are reviewer-only", () => {
  const expectedArtifactPath = "PHASE_5_SPEC.md";
  const executorOut = buildExecutorPrompt({
    role: "executor",
    specRepoRelPath: "PHASE_4_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    retryNote: null,
  });
  const reviewerOut = buildReviewerPrompt({
    specRepoRelPath: "PHASE_4_SPEC.md",
    handoffAbsPath: "/repo/handoff.json",
    babyPrdRepoRelPath: BABY_PRD_REPO_REL_PATH,
    contextRepoRelPath: CONTEXT_REPO_REL_PATH,
    priorRecord: priorRecord(),
    diff: "diff",
    expectedArtifactPath,
    isFinalPhase: false,
    retryNote: null,
  });

  const productionInstructions = buildArtifactProductionInstructions(expectedArtifactPath, false);
  assert.ok(reviewerOut.includes(productionInstructions));
  assert.ok(!executorOut.includes(productionInstructions));
  assert.ok(!executorOut.includes("You must genuinely produce loopr's next phase artifact"));
});
