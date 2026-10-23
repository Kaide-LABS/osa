// Implements PHASE_3_SPEC.md §6.2
//
// Role-profile injection and isolation-respecting cross-turn context assembly (FM2). No function
// in this file ever reads `process.env`, spawns a process, or touches a clock -- consistent with
// `buildInvocation`'s own purity constraint (PHASE_1_SPEC.md §3.6), applied here to the layer one
// step upstream of it.

import type { HandoffRecord } from "../domain/relay.ts";
import { RELAY_SCHEMA_VERSION } from "../domain/relay.ts";
import { getRole } from "../domain/roles.ts";
import { PROVIDER_IDS } from "../domain/run.ts";
import { MODEL_TIERS } from "../domain/tiers.ts";

function quotedList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

/**
 * The eighteen top-level `HandoffRecord` fields, in schema-declaration order (PHASE_1_SPEC.md
 * §3.4), each annotated with the *value shape* it must carry -- not merely its name.
 *
 * [DECISION] The bare name list this replaced was genuinely ambiguous in live dispatch: a real
 * Claude Code executor turn wrote `"schema_version": "1.0"` (a plausible semver-looking string, the
 * overwhelmingly common convention for a field with that name) where the schema requires the bare
 * integer `1`, and the relay's own validation correctly refused the turn. A field name alone does
 * not communicate a value shape, so every field states one, and the literals are read from the
 * canonical schemas (`RELAY_SCHEMA_VERSION`, `PROVIDER_IDS`, `MODEL_TIERS`) rather than duplicated,
 * so the prompt cannot drift from what `parseHandoffRecord()` actually enforces.
 */
function handoffRecordFieldSpecLines(role: "executor" | "reviewer"): readonly string[] {
  return [
    `- schema_version: the bare JSON integer ${String(RELAY_SCHEMA_VERSION)} -- no quotes, no ` +
      `decimal point. This is a schema revision number, not a semver string: "1.0", "1.0.0", and ` +
      `the quoted string "${String(RELAY_SCHEMA_VERSION)}" are all rejected outright.`,
    "- run_id: this run's UUID string. It is the directory name directly under runs/ in the " +
      "handoff path above -- copy it from there, do not invent one.",
    "- phase: a bare integer >= 1 (no quotes). It is the directory name directly under handoff/ " +
      "in the handoff path above.",
    "- turn_index: a bare integer >= 0 (no quotes). The handoff file name starts with this number " +
      "zero-padded; write the field itself as a plain integer, so 000 in the file name is 0 here.",
    `- role: exactly "executor" or "reviewer". For this turn it is "${role}".`,
    `- provider: exactly one of ${quotedList(PROVIDER_IDS)} -- whichever of them appears in the ` +
      "handoff file name above.",
    `- model_tier: exactly one of ${quotedList(MODEL_TIERS)}.`,
    '- started_at, completed_at: ISO-8601 UTC timestamp strings ending in "Z", for example ' +
      '"2026-01-01T09:30:00Z". A numeric offset such as +01:00 is rejected. completed_at must be ' +
      ">= started_at.",
    "- repo: an object with branch (string), head_before, head_after (full git object ids), and " +
      "commits (array of full git object ids).",
    "- spec_ref: an object with path (repo-relative POSIX path) and sha256 (64 lowercase hex " +
      "characters).",
    "- artifacts_read, artifacts_written: arrays (possibly empty) of objects with the same " +
      "path/sha256 shape as spec_ref.",
    '- status: exactly one of "completed", "blocked", "halted".',
    "- work_done: a single non-empty string.",
    "- next_steps, open_questions: arrays of strings, each array possibly empty.",
    "- halt: null, or an object with code (an UPPER_SNAKE_CASE identifier string) and message (a " +
      'non-empty string). It must be non-null exactly when status is "halted", and null otherwise.',
  ];
}

/** A very large diff would make an invocation's `stdin` payload unboundedly large; capped here. */
const DIFF_CAP_CHARS = 20_000;

/**
 * Matches a leading YAML frontmatter block (`---\n...\n---\n`), the Claude Code subagent metadata
 * (`name`/`description`/`model`/`effort`) that `loopr customize --step 11/12` writes at the top of
 * its output file. That block is spawn-mechanism metadata for a single provider's subagent
 * dispatch, not part of the role's actual task content, so it is never appropriate to hand a
 * provider as part of its prompt text.
 */
const YAML_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * Prepares a target build's own customized loopr Step 11/12 prompt file (read verbatim by the
 * caller, e.g. from `RunConfig.executor_prompt_path`/`reviewer_prompt_path`) for inclusion in a
 * dispatched turn's prompt, regardless of which provider executes that turn.
 *
 * Strips a leading YAML frontmatter block if present (see {@link YAML_FRONTMATTER_RE}) and
 * prepends a short notice neutralizing any single-provider environment phrasing the body still
 * carries -- these files are customized once per project and routinely say things like "Run in
 * Claude Code" (see e.g. `.claude/agents/loopr-step11.md`), because they were originally authored
 * for a Claude-Code-only subagent dispatch. That phrasing does not describe a constraint on this
 * dispatch: OSA may run this exact turn under either provider, and its own protocol
 * instructions (built separately by {@link buildProtocolInstructions} and always placed after this
 * content) are what actually govern the handoff record, the commit requirement, and isolation --
 * regardless of anything this file's body says about environment or process.
 */
export function sanitizeProjectRolePrompt(raw: string): string {
  const body = raw.replace(YAML_FRONTMATTER_RE, "").trim();
  return [
    "The following is this project's own loopr methodology for this role, exactly as customized " +
      "for this build. It may reference running in a specific tool (e.g. \"Run in Claude Code\") or " +
      "name a specific provider -- that reflects how it was originally authored for a single " +
      "provider's subagent dispatch, not a constraint on this dispatch: this turn may be executed " +
      "by a different provider than the one named below, and OSA's own protocol " +
      "instructions that follow this section (handoff record, commit requirement, isolation) are " +
      "authoritative regardless of which provider you are.",
    "",
    body,
  ].join("\n");
}

/** Parameters for {@link buildProtocolInstructions}. */
export interface ProtocolInstructionParams {
  readonly handoffAbsPath: string;
  readonly role: "executor" | "reviewer";
  readonly specRepoRelPath: string;
  /** Repo-relative path to loopr's `baby_prd.md` for this build (PHASE_4_SPEC.md §6.2, new). */
  readonly babyPrdRepoRelPath: string;
  /** Repo-relative path to loopr's `context.md` for this build (PHASE_4_SPEC.md §6.2, new). */
  readonly contextRepoRelPath: string;
}

/**
 * Renders the protocol instructions every dispatched turn receives: the exact `HandoffRecord`
 * shape to produce (name *and* value shape per field -- see
 * {@link handoffRecordFieldSpecLines}), where to write it, the isolation rule, the requirement to
 * really commit the turn's work, the advisory-only nature of agent-authored `repo`/`spec_ref`, the
 * honest-halt requirement, and (Phase 4, new) the instruction to genuinely read and record all
 * three of loopr's own artifacts for this build -- `baby_prd.md`, `context.md`, *and* the phase spec
 * itself -- in `artifacts_read`. Prose is not fixed verbatim by the spec -- what is
 * load-bearing is that each of the eight mandatory-content items appears as a literal substring
 * (PHASE_3_SPEC.md §6.2 items 1-6, PHASE_4_SPEC.md §6.2 items 7-8, all tested individually); item
 * 2's eighteen field names now appear as an annotated list rather than a bare comma-joined one,
 * which satisfies the same substring requirement while removing the value-shape ambiguity that
 * broke a live dispatch. Shared verbatim by {@link buildExecutorPrompt} and
 * {@link buildReviewerPrompt}, so the commit requirement below binds both roles from one place.
 *
 * [DECISION] The commit requirement is stated explicitly, and item 4's "advisory only" sentence is
 * scoped explicitly to *field values*, because the pair was genuinely ambiguous in live dispatch: a
 * real Claude Code executor turn did the phase's actual work (wrote the module, wrote its tests,
 * ran them green) and reported `status: "completed"` without ever running `git add`/`git commit` --
 * a plausible reading of "do not spend turn budget trying to get git plumbing exactly right" is
 * "git is optional here". Ground-truth reconciliation (`src/dispatch/record.ts`) correctly saw
 * `head_before === head_after`, `commits: []`, and refused the turn on R3 (`src/domain/relay.ts`).
 * The advisory note is true of the *values* the agent self-reports for `repo`/`spec_ref`; it was
 * never permission to skip the underlying action, so the two ideas are now separated and each
 * bounded. The neutral-commit-message clause rides along deliberately: the turn is now told to
 * commit, and an attribution trailer in that commit is a hard `BoundaryViolationError`
 * (`src/verify/commits.ts`, PRD §7 I4) that fails the run with no retry -- strictly worse than the
 * retryable R3 refusal it would replace -- so the requirement and its constraint are stated
 * together.
 *
 * [DECISION] The commit requirement is followed by one explicitly narrow exception, because the
 * requirement as first written was unsatisfiable for one real provider on one real platform: Codex
 * CLI runs under `--sandbox workspace-write` unconditionally (`CodexCliAdapter.buildInvocation()`,
 * PRD §9 FM7), and on Windows that sandbox denies writes to `.git/` outright -- verified directly
 * against a real repo, where every `git` write returned `fatal: Unable to create
 * '<repo>/.git/index.lock': Permission denied`. An agent told only "you must commit" and unable to
 * comply has no honest move left but `status: "blocked"`, which would fail turns whose actual work
 * was finished. `runTurn()` step 5.5 (`src/dispatch/turn.ts`) now commits such leftovers itself, so
 * the prompt states the fallback exists. It is worded as *inability*, not permission: the exception
 * names the concrete failure (git refuses with a permission error), requires attempting the commit
 * first, and says outright that it does not apply when git works. That deliberate narrowness is a
 * direct response to the original bug -- a broadly-worded "you don't strictly have to commit" is
 * exactly the ambiguity that caused a live turn to skip committing entirely, and softening the rule
 * generally to unblock one sandbox would reintroduce it.
 *
 * [DECISION] The phase-spec sentence carries the same explicit "and record it in artifacts_read"
 * clause as the `baby_prd.md`/`context.md` sentences, because its absence was genuinely
 * load-bearing in live dispatch: a real Claude Code executor turn read and used all three artifacts
 * (its `work_done` narrative and the code it wrote both reflect having read the spec), but its
 * `artifacts_read` listed only `baby_prd.md` and `context.md` -- the two artifacts whose sentences
 * asked for the recording -- and `assertLooprArtifactsReferenced()` (`src/dispatch/artifacts.ts`,
 * PRD §2 AC3) correctly refused the turn on the missing `spec_path`. An instruction that says only
 * "read X and do the work" is a complete, self-consistent instruction on its own terms; nothing in
 * it implies a bookkeeping obligation that the two neighbouring sentences state outright. All three
 * required artifacts are now asked for identically, so the prompt's coverage matches exactly what
 * `assertLooprArtifactsReferenced()` enforces. Implements PHASE_3_SPEC.md §6.2, PHASE_4_SPEC.md
 * §6.2.
 */
export function buildProtocolInstructions(p: ProtocolInstructionParams): string {
  return [
    `You are participating in an OSA dispatched ${p.role} turn.`,
    `Read the phase spec at repo-relative path "${p.specRepoRelPath}", do the work it describes, ` +
      `and record it in artifacts_read.`,
    "",
    `Read loopr's foundational problem-statement artifact for this build at repo-relative path ` +
      `"${p.babyPrdRepoRelPath}" and record it in artifacts_read.`,
    "",
    `Read loopr's foundational context artifact for this build at repo-relative path ` +
      `"${p.contextRepoRelPath}" and record it in artifacts_read.`,
    "",
    `When your turn ends (whether complete or not), write a single JSON HandoffRecord document to ` +
      `the exact path "${p.handoffAbsPath}". The record must be a JSON object with exactly these ` +
      `eighteen top-level fields, each carrying exactly the value shape stated here:`,
    ...handoffRecordFieldSpecLines(p.role),
    "",
    "These value shapes are validated mechanically and a mismatch refuses the whole turn, so " +
      "follow them literally rather than substituting a conventional-looking equivalent.",
    "",
    "You must commit your work to git before your turn ends. Stage and commit every file you " +
      "created or modified this turn (git add, then git commit), so that at least one new commit " +
      "exists on the branch when you finish. This is a real action you have to perform, not " +
      "bookkeeping: OSA reads the branch's own git history itself, comparing HEAD before " +
      "your turn against HEAD after it, and mechanically refuses the entire turn if you report " +
      'status: "completed" with no new commit. Work left uncommitted in the working tree does not ' +
      "count, however genuinely it was done.",
    "",
    "There is exactly one exception, and it is narrow: if your own environment physically prevents " +
      "you from writing to git -- a sandbox that denies write access to the .git directory, so that " +
      "git itself fails with a permission error you cannot work around -- then leave your finished " +
      "work in the working tree exactly as it is, say so plainly in work_done, and finish your turn. " +
      "OSA detects working-tree changes after your process exits and commits them on your " +
      "behalf. In that specific case only, an uncommitted working tree is not a reason to report " +
      'status: "blocked": if the actual task the spec asked for is genuinely done, report status: ' +
      '"completed". This exception is about being unable, never about not having got round to it. ' +
      "If git works in your environment, the paragraph above applies in full and you must run the " +
      "commit yourself -- attempt it first, and fall back to this only after git has actually " +
      "refused you.",
    "",
    "Keep the commit message neutral and factual -- describe the change itself, and add no " +
      "AI-attribution or model-generation trailer of any kind (no co-authored-by line naming an AI " +
      'assistant or model, no "generated with" tool credit, no emoji generation credit). A commit ' +
      "carrying one of those fails the whole run outright as a boundary violation, with no retry.",
    "",
    "The repo and spec_ref values you write are advisory only: OSA independently " +
      "recomputes both from its own git and file-hash inspection after your turn ends, and " +
      "overwrites whatever you wrote there -- do not spend turn budget trying to get git plumbing " +
      "exactly right. That is strictly about the accuracy of those two fields' values, and about " +
      "nothing else: it does not make committing optional. Recording the wrong commit ids costs " +
      "you nothing; not making the commit refuses the turn.",
    "",
    "work_done, next_steps, and open_questions must be strictly factual: a record of what was " +
      "done and what remains, never your reasoning, chain of thought, or a transcript excerpt, and " +
      "never under a key name that resembles one either. This is PRD §6.4's isolation rule, " +
      "enforced mechanically before your record is even parsed.",
    "",
    'If you cannot complete the phase, report status: "blocked" or status: "halted" (with a ' +
      'populated halt object) honestly. Never report status: "completed" when the phase is not ' +
      "actually done.",
  ].join("\n");
}

/**
 * [DET] Renders exactly the allow-listed fields of `prev` as plain text: `work_done`,
 * `next_steps`, `open_questions`, `artifacts_written`, `status`, `spec_ref`. Never `prev`'s raw
 * JSON dump wholesale (schema-shape leakage, not a deliberate allow-list) and never any provider
 * log/stdout/stderr text -- this function's signature takes only a {@link HandoffRecord}, never a
 * `RawInvocationResult`, so there is no raw process output available to leak even by mistake.
 * Applies PRD §7 I5's isolation rule uniformly to both the second executor turn's context and the
 * reviewer's context. Implements PHASE_3_SPEC.md §6.2.
 *
 * [DECISION] The `artifacts_written` list is followed by an explicit instruction to read each of
 * those files back and record every one of them in the receiving turn's own `artifacts_read`,
 * because its absence was load-bearing in live dispatch: a real cross-provider handoff (Claude Code
 * turn 0 wrote `wordcount.mjs` and `wordcount.test.mjs`; Codex CLI turn 1 demonstrably read and
 * extended both -- its `work_done` describes adding a regression test to the existing suite) was
 * refused as `IGNORED (failed: C5_ARTIFACT_ATTESTATION)`, twice, because the receiving turn's
 * `artifacts_read` listed only the three loopr artifacts whose own instructions ask for the
 * recording. The list above is rendered as informational context, and informational context implies
 * no bookkeeping obligation -- exactly the gap the phase-spec sentence had in
 * {@link buildProtocolInstructions}. `checkC5ArtifactAttestation()` (`src/verify/continuity.ts`,
 * PRD §2 AC1/AC3) is the mechanical proof that the second agent picked up the first agent's real
 * work, so the prompt now asks for precisely what that check reads.
 *
 * Placed here rather than in {@link buildProtocolInstructions} for two reasons. It fires exactly
 * when it applies: {@link buildExecutorPrompt} calls this function only for `priorRecord !== null`,
 * so a fresh first turn -- which has no prior artifacts and is never a C5 subject -- never sees it,
 * while every turn that *is* a C5 subject does. And it sits directly beneath the concrete paths it
 * refers to, so "each of the files listed above" resolves without the turn having to correlate two
 * distant sections. {@link buildReviewerPrompt} calls this same function unconditionally, and
 * `runTurn()`'s loop runs `verifyContinuation()` over *every* consecutive pair including
 * executor->reviewer (`src/dispatch/run-loop.ts`), so the reviewer is bound by C5 identically and is
 * covered by this one placement -- no separate reviewer-side statement is needed.
 */
export function buildHandoffContext(prev: HandoffRecord): string {
  const lines: string[] = [];
  lines.push("Prior turn's handoff context (allow-listed fields only):");
  lines.push(`status: ${prev.status}`);
  lines.push(`spec_ref: ${prev.spec_ref.path} (sha256 ${prev.spec_ref.sha256})`);
  lines.push(`work_done: ${prev.work_done}`);
  lines.push("next_steps:");
  for (const step of prev.next_steps) {
    lines.push(`  - ${step}`);
  }
  lines.push("open_questions:");
  for (const question of prev.open_questions) {
    lines.push(`  - ${question}`);
  }
  lines.push("artifacts_written:");
  for (const artifact of prev.artifacts_written) {
    lines.push(`  - ${artifact.path} (sha256 ${artifact.sha256})`);
  }
  if (prev.artifacts_written.length > 0) {
    lines.push("");
    lines.push(
      "You must genuinely open and read every file listed under artifacts_written above before you " +
        "do your own work -- that is the prior turn's actual output, and this turn's job is to " +
        "continue it, not to restart it.",
    );
    lines.push(
      "You must then record every one of those paths, with its SHA-256, in your own record's " +
        "artifacts_read array -- each one, not a representative sample, and in addition to the " +
        "loopr artifacts you were already told to record there. This is checked mechanically and it " +
        "is the single check that proves you continued the prior agent's real work: OSA " +
        "verifies that every artifact the prior turn wrote was genuinely read back by this turn, by " +
        "path and by matching hash, and refuses the entire turn if even one of them is missing from " +
        "artifacts_read. Having read a file, and having said so in work_done, does not count -- the " +
        "path has to be in artifacts_read.",
    );
  }
  return lines.join("\n");
}

function truncateDiff(diff: string): string {
  if (diff.length <= DIFF_CAP_CHARS) {
    return diff;
  }
  return `${diff.slice(0, DIFF_CAP_CHARS)}\n...[diff truncated at ${String(DIFF_CAP_CHARS)} characters]...\n`;
}

/** Parameters for {@link buildExecutorPrompt}. */
export interface BuildExecutorPromptParams {
  readonly role: "executor";
  readonly specRepoRelPath: string;
  readonly handoffAbsPath: string;
  /** Repo-relative path to loopr's `baby_prd.md` for this build (PHASE_4_SPEC.md §1.4, new). */
  readonly babyPrdRepoRelPath: string;
  /** Repo-relative path to loopr's `context.md` for this build (PHASE_4_SPEC.md §1.4, new). */
  readonly contextRepoRelPath: string;
  readonly priorRecord: HandoffRecord | null;
  readonly retryNote: string | null;
  /**
   * This build's own customized loopr Step 11 prompt content, already sanitized via
   * {@link sanitizeProjectRolePrompt} by the caller -- or `null`/omitted when
   * `RunConfig.executor_prompt_path` was not supplied for this run. Optional (rather than a
   * required `string | null`, unlike `priorRecord`/`retryNote`) so every pre-existing call site
   * that has no reason to know about this capability keeps parsing unchanged.
   */
  readonly roleTaskInstructions?: string | null;
}

/**
 * Concatenates: `getRole("executor").profileSummary` + (`roleTaskInstructions`, when supplied --
 * this build's own customized loopr Step 11 methodology) + {@link buildProtocolInstructions} (now
 * including the baby_prd/context mandatory-content items) +
 * (`priorRecord === null` ? nothing : {@link buildHandoffContext}, for the second executor turn) +
 * (`retryNote` when non-null). No production-instruction block is ever added for an executor turn
 * -- {@link buildArtifactProductionInstructions} is reviewer-only. Implements PHASE_3_SPEC.md §6.2,
 * PHASE_4_SPEC.md §6.2.
 */
export function buildExecutorPrompt(params: BuildExecutorPromptParams): string {
  const parts: string[] = [getRole("executor").profileSummary];
  if (params.roleTaskInstructions !== null && params.roleTaskInstructions !== undefined) {
    parts.push(params.roleTaskInstructions);
  }
  parts.push(
    buildProtocolInstructions({
      handoffAbsPath: params.handoffAbsPath,
      role: "executor",
      specRepoRelPath: params.specRepoRelPath,
      babyPrdRepoRelPath: params.babyPrdRepoRelPath,
      contextRepoRelPath: params.contextRepoRelPath,
    }),
  );
  if (params.priorRecord !== null) {
    parts.push(buildHandoffContext(params.priorRecord));
  }
  if (params.retryNote !== null) {
    parts.push(params.retryNote);
  }
  return parts.join("\n\n");
}

/**
 * [DECISION Phase 4] Reviewer-only addendum instructing the reviewer to genuinely write loopr's
 * next phase artifact as part of this turn, never merely reference it -- the mechanical
 * counterpart to `assertNextPhaseSpecProduced()` (`src/dispatch/artifacts.ts`). Prose is not fixed
 * verbatim, but two items are load-bearing and tested by substring: (1) the literal
 * `expectedArtifactPath`, as the exact repo-relative path the reviewer must write real content to;
 * (2) an explicit statement, branching on `isFinalPhase`, of what that content must be -- the real
 * next phase's technical blueprint on a non-final phase, this build's completion record on the
 * final phase -- and that the path must be recorded, with its real hash, in `artifacts_written`, or
 * OSA will treat the phase as bypassed, not completed. A third line restates, at the point
 * the reviewer is told to write this specific file, that it must land in the turn's real git commit
 * -- {@link buildProtocolInstructions}'s shared commit requirement already binds the reviewer, and
 * this is the one file a reviewer turn is most likely to leave untracked. Never called from
 * {@link buildExecutorPrompt}. Implements PHASE_4_SPEC.md §6.2.
 */
export function buildArtifactProductionInstructions(expectedArtifactPath: string, isFinalPhase: boolean): string {
  const contentDescription = isFinalPhase
    ? "this build's completion record"
    : `the real next phase's technical blueprint (following this project's own established spec ` +
      `structure), at "${expectedArtifactPath}"`;
  return [
    "You must genuinely produce loopr's next phase artifact for real, as part of this turn -- " +
      "not merely reference or restate an existing one.",
    `Write substantive, real content to the exact repo-relative path "${expectedArtifactPath}". ` +
      `That content must be ${contentDescription}.`,
    `You must also record "${expectedArtifactPath}" with its real SHA-256 hash in ` +
      "artifacts_written -- otherwise OSA will treat this phase as bypassed, not completed.",
    `Commit "${expectedArtifactPath}", along with every other file you changed this turn, in this ` +
      "turn's own git commit -- the commit requirement in the protocol instructions above covers " +
      "this file too.",
  ].join("\n");
}

/** Parameters for {@link buildReviewerPrompt}. */
export interface BuildReviewerPromptParams {
  readonly specRepoRelPath: string;
  readonly handoffAbsPath: string;
  /** Repo-relative path to loopr's `baby_prd.md` for this build (PHASE_4_SPEC.md §1.4, new). */
  readonly babyPrdRepoRelPath: string;
  /** Repo-relative path to loopr's `context.md` for this build (PHASE_4_SPEC.md §1.4, new). */
  readonly contextRepoRelPath: string;
  readonly priorRecord: HandoffRecord;
  readonly diff: string;
  /** The repo-relative path this reviewer turn must genuinely produce (PHASE_4_SPEC.md §1.4, new). */
  readonly expectedArtifactPath: string;
  /** Whether this run's reviewer turn is the target build's own final phase (PHASE_4_SPEC.md §1.4, new). */
  readonly isFinalPhase: boolean;
  readonly retryNote: string | null;
  /**
   * This build's own customized loopr Step 12 prompt content, already sanitized via
   * {@link sanitizeProjectRolePrompt} by the caller -- or `null`/omitted when
   * `RunConfig.reviewer_prompt_path` was not supplied for this run. Same optional-rather-than-
   * required treatment as {@link BuildExecutorPromptParams.roleTaskInstructions}, for the same
   * pre-existing-call-site reason.
   */
  readonly roleTaskInstructions?: string | null;
}

/**
 * Concatenates: `getRole("reviewer").profileSummary` + (`roleTaskInstructions`, when supplied --
 * this build's own customized loopr Step 12 methodology) + {@link buildProtocolInstructions} (now
 * including the baby_prd/context mandatory-content items) +
 * {@link buildArtifactProductionInstructions} (Phase 4, new -- placed immediately after the
 * protocol instructions and before the handoff/diff context, matching the existing convention that
 * instructions-about-the-task precede context-about-prior-work) + {@link buildHandoffContext} + a
 * capped rendering of `params.diff` + (`retryNote` when non-null). The literal, mechanical form of
 * PRD §9 FM2: "the reviewer's turn payload is assembled only from `spec_ref` + git diff + the
 * previous `HandoffRecord`'s allow-listed fields -- never from provider log files". Implements
 * PHASE_3_SPEC.md §6.2, PHASE_4_SPEC.md §6.2.
 */
export function buildReviewerPrompt(params: BuildReviewerPromptParams): string {
  const parts: string[] = [getRole("reviewer").profileSummary];
  if (params.roleTaskInstructions !== null && params.roleTaskInstructions !== undefined) {
    parts.push(params.roleTaskInstructions);
  }
  parts.push(
    buildProtocolInstructions({
      handoffAbsPath: params.handoffAbsPath,
      role: "reviewer",
      specRepoRelPath: params.specRepoRelPath,
      babyPrdRepoRelPath: params.babyPrdRepoRelPath,
      contextRepoRelPath: params.contextRepoRelPath,
    }),
    buildArtifactProductionInstructions(params.expectedArtifactPath, params.isFinalPhase),
    buildHandoffContext(params.priorRecord),
    `Diff under review (${params.specRepoRelPath}'s executor turns):\n${truncateDiff(params.diff)}`,
  );
  if (params.retryNote !== null) {
    parts.push(params.retryNote);
  }
  return parts.join("\n\n");
}
