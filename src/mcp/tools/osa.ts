// The one-shot flow as MCP tools: osa_plan -> (the person confirms, in their own chat) -> osa_build -> osa_status.
//
// The CLI asks for the lock in a terminal. An MCP client has no terminal, so the lock becomes two tool calls with the person's yes in between:
//   osa_plan    runs intake only and returns the plan (TL;DR, criteria, tagged assumptions) plus a fingerprint of exactly that plan. Nothing is locked.
//   osa_build   locks THAT plan (the fingerprint must match the file on disk, so the plan locked is the plan shown) and runs the whole pipeline in the
//               background of the MCP server process; it returns at once, because a build takes tens of minutes and a tool call must not.
//   osa_status  reads the run's own files, so it also works after the server restarted (a job lost with the process is reported as "interrupted").
// The tool descriptions tell the calling assistant to show the plan and get an explicit yes; the server additionally refuses a plan whose risky
// assumptions were not explicitly accepted, and a fingerprint that does not match, so a confirmation cannot be applied to a different plan.

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError, UsageError } from "../../domain/errors.ts";
import { parseBabyPrd } from "../../osa/baby-prd.ts";
import type { GateIO } from "../../osa/lock.ts";
import type { OsaCommandOptions, OsaDeps, OsaRunReport } from "../../osa/pipeline.ts";
import { runOsaCommand } from "../../osa/pipeline.ts";
import { lastFinishedPhase } from "../../osa/build-resume.ts";
import { readResumeState } from "../../osa/resume-state.ts";
import type { ResumeState } from "../../osa/resume-state.ts";
import { SpecGateRecord, buildSpecManifest, changedApprovedSpecFiles, specGateRecordPath } from "../../osa/spec-gate.ts";
import { sha256String } from "../../util/hash.ts";
import { buildFreshnessWarning } from "../../verify/build-stamp.ts";
import { runCancelScope } from "../../util/exec.ts";
import { osaDir } from "../../util/paths.ts";

// ---- schemas ---------------------------------------------------------------------------------------------------------------------

export const PlanInput = z.strictObject({
  /** The repository to build in: an existing git repository with at least one commit. */
  repo_dir: z.string().min(1),
  /** What the person wants built, in their own words. */
  prompt: z.string().trim().min(1).max(40_000),
  /** Optional files (repo-relative or absolute) whose content is given to the planner as context. */
  files: z.array(z.string().min(1)).max(20).default([]),
  /** Answers to intake's recommended questions, keyed by the question text. */
  answers: z.record(z.string(), z.string()).default({}),
});
export type PlanInput = z.infer<typeof PlanInput>;

/** One seat: which provider, and which model (null = the provider's own default model, whatever its CLI picks). */
const SeatShape = z.strictObject({ provider: z.string(), model: z.string().nullable() });

/**
 * Who OSA actually put in which seat, read back from the run's own `seats_resolved` / `review_independence` events. The config is read each time a
 * stage starts, so this is what the stage really used, not what the config file says now.
 */
export const ResolvedSeats = z.strictObject({
  /** Seat 0 then seat 1. Seat 1 writes the build, seat 0 reviews it. */
  seats: z.tuple([SeatShape, SeatShape]),
  build_author: SeatShape.nullable(),
  build_reviewer: SeatShape.nullable(),
  /** How independent the reviewer is from the author (e.g. different-family, same-model). */
  review_independence: z.string().nullable(),
  /** True when OSA chose the providers from what is installed; false when osa.config.json named them. */
  chosen_automatically: z.boolean(),
  /** The config file that was read, or null when there was none (defaults). */
  config_source: z.string().nullable(),
  /** Set when a seat has no model named: it runs on the provider's own default, which may not be the model you expect. */
  model_note: z.string().nullable(),
  notes: z.array(z.string()),
});
export type ResolvedSeats = z.infer<typeof ResolvedSeats>;

export const PlanOutput = z.strictObject({
  run_id: z.uuid(),
  /** Fingerprint of exactly this plan; osa_build must echo it. */
  plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  tldr: z.string(),
  /** The whole plan as markdown: problem, scope, acceptance criteria, constraints, research plan, assumptions. */
  plan_markdown: z.string(),
  /** Scope of the prompt: 'narrow' (specific) or 'broad' (vague). */
  scope: z.enum(["narrow", "broad"]),
  /** Questions recommended to answer before proceeding; up to 3 when scope is 'broad', empty when 'narrow'. */
  recommended_questions: z.array(z.strictObject({ question: z.string(), default: z.string() })),
  /** Assumptions OSA made that would change scope, architecture, data handling, cost or security if wrong. Show these first. */
  risky_assumptions: z.array(z.string()),
  /** Assumptions derived from unanswered recommended questions (the defaults). */
  defaulted_assumptions: z.array(z.string()),
  /** Assumptions OSA made that are reversible or low-impact; excludes defaulted assumptions. */
  safe_assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  next_step: z.string(),
  /** The seats the planning stage resolved. They are resolved again when osa_spec starts, so editing osa.config.json before osa_spec still takes effect. */
  seats: ResolvedSeats.nullable(),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const BuildInput = z.strictObject({
  repo_dir: z.string().min(1),
  run_id: z.uuid(),
  /** The spec_sha256 osa_status reported for the spec the person was shown. */
  spec_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** "lock" = the person approved this spec and the build may start; "cancel" = they did not. */
  decision: z.enum(["lock", "cancel"]),
  /** Required to be true when the plan lists risky assumptions: only after the person has read and accepted each one. */
  accept_risky_assumptions: z.boolean().default(false),
});
export type BuildInput = z.infer<typeof BuildInput>;

export const BuildOutput = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(["started", "cancelled"]),
  message: z.string(),
  /** The seats this run resolved when its research and spec started; the build uses these. Null when the run recorded none. */
  seats: ResolvedSeats.nullable(),
});
export type BuildOutput = z.infer<typeof BuildOutput>;

export const SpecInput = z.strictObject({
  repo_dir: z.string().min(1),
  run_id: z.uuid(),
  /** The plan_sha256 returned by osa_plan to verify the request file matches. */
  plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** "go" = start research and spec in the background; "cancel" = discard the plan. */
  decision: z.enum(["go", "cancel"]),
});
export type SpecInput = z.infer<typeof SpecInput>;

export const SpecOutput = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(["started", "cancelled"]),
  message: z.string(),
});
export type SpecOutput = z.infer<typeof SpecOutput>;

export const CancelInput = z.strictObject({
  repo_dir: z.string().min(1),
  /** The run to stop. */
  run_id: z.uuid(),
});
export type CancelInput = z.infer<typeof CancelInput>;

export const CancelOutput = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(["cancelled", "not_running"]),
  message: z.string(),
});
export type CancelOutput = z.infer<typeof CancelOutput>;

export const StatusInput = z.strictObject({
  repo_dir: z.string().min(1),
  /** Omit for the most recent run in this repository. */
  run_id: z.uuid().optional(),
});
export type StatusInput = z.infer<typeof StatusInput>;

export const RUN_STATES = ["awaiting_confirmation", "running", "finished", "stopped", "cancelled", "interrupted"] as const;

export const StatusOutput = z.strictObject({
  run_id: z.uuid(),
  state: z.enum(RUN_STATES),
  /** The pipeline stage the run is in (or reached): plan, research, spec, agents, build, verify, summary. */
  stage: z.string(),
  message: z.string(),
  recent_events: z.array(z.strictObject({ at: z.string(), event: z.string() })),
  /** The run report once the run has ended, else null. */
  report: z.unknown().nullable(),
  /** The plain-language summary the run wrote (first part), once it exists. */
  summary_markdown: z.string().nullable(),
  /** The deterministic TL;DR shown at the post-spec gate, null until the spec is complete. */
  tldr: z.array(z.string()).nullable(),
  /** The spec-gate hash (64 hex), null until the spec is complete. */
  spec_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** Risky assumptions from the locked PRD, empty array when not applicable. */
  risky_assumptions: z.array(z.string()),
  /** Defaulted assumptions (from unanswered recommended questions), empty array when not applicable. */
  defaulted_assumptions: z.array(z.string()),
  /** The seats this run resolved (provider and model), null before any stage has started. */
  seats: ResolvedSeats.nullable(),
});
export type StatusOutput = z.infer<typeof StatusOutput>;

export const PLAN_TOOL_DESCRIPTION =
  "Step 1 of OSA's one-shot build. Turns a request into a plain-language plan (TL;DR, scope, acceptance criteria, tagged assumptions) and writes it " +
  "into the repository. Show the person the plan (risky assumptions first) before proceeding. The plan lists up to 3 recommended questions when scope is broad; " +
  "answering them (by calling osa_plan again with answers) saves a ~20 minute research and spec run. NOTHING is built or locked. Skipping answers is fine: " +
  "they become defaults listed as 'defaulted assumptions'. Show the person any warnings; one saying OSA's compiled code is out of date means the running server is behind the source and needs a rebuild and restart. The result's seats say which provider and model will do the work (model null = that provider's own default): show them too. Only after the person has explicitly approved, call osa_spec to start research and spec. Takes about a minute.";
export const SPEC_TOOL_DESCRIPTION =
  "Step 2 of OSA's one-shot build: start research and spec in the background after the person has seen the plan from osa_plan. Returns immediately; the " +
  "run reaches the post-spec gate and stops there waiting for approval. Follow progress with osa_status. Never call this step without the person's explicit yes. " +
  "Typically takes 15 to 20 minutes. Once the spec is ready, osa_status shows awaiting_confirmation and the deterministic TL;DR; only then call osa_build. " +
  "Also carries on a run that was lost, or stopped with osa_cancel, before its build began (call it again with the same run_id and plan_sha256; research that " +
  "already finished is kept). osa_status says when a run can be carried on this way.";
export const BUILD_TOOL_DESCRIPTION =
  "Step 3 of OSA's one-shot build. Only after osa_status shows awaiting_confirmation at stage spec and the person has seen the TL;DR: lock the spec and " +
  "run the build in the background. Pass the spec_sha256 from osa_status; it must match the spec the person was shown. Show the person the TL;DR (risky " +
  "assumptions first) and call this only on their explicit yes. If risky assumptions are present, set accept_risky_assumptions to true only after the " +
  "person has read and accepted each one: never set accept_risky_assumptions yourself. decision \"cancel\" stops the run without building. Also works after the MCP server restarted, when osa_status still shows awaiting_confirmation at stage spec: the run is carried on from its saved spec. And it carries on a build that was interrupted part-way (osa_status says so and gives the spec_sha256): finished phases are kept. Typically " +
  "30 to 60 minutes. The result's seats echo the provider and model the build will use. Follow with osa_status.";
export const CANCEL_TOOL_DESCRIPTION =
  "Stop a run that is working in the background (research, spec or build) right now: the agent processes it started are killed and nothing further is " +
  "started. Use it when the person says to stop, or a run is stuck. Work already committed to the repository stays there (it is not undone); research and spec " +
  "files stay under runs/ for reference. If the build had not begun, the run is not lost: osa_spec on the same run carries it on and keeps the research that " +
  "finished (use this when a step was stuck, not when the person wants the run abandoned). A run that is only waiting for a decision can also be declined through osa_build or osa_spec with decision \"cancel\". " +
  "Only works on runs started by this server process; after a server restart a run shows as interrupted and has nothing left to stop.";
export const STATUS_TOOL_DESCRIPTION =
  "Progress and result of an OSA run: its state (awaiting_confirmation, running, finished, stopped, cancelled, interrupted), the stage, recent events, and, " +
  "when awaiting_confirmation at spec stage, the TL;DR, spec_sha256, and risky/defaulted assumptions. Once the run has ended, the report and the " +
  "plain-language summary are attached. seats shows the provider and model each seat actually resolved to for this run. Poll it every few minutes while a run executes.";

// ---- files of one run --------------------------------------------------------------------------------------------------------------

const runDir = (repoDir: string, runId: string): string => `${osaDir(repoDir)}/runs/${runId}`;
const draftPath = (repoDir: string, runId: string): string => `${repoDir}/runs/${runId}/baby-prd.md`;

const PlanRequestFile = z.strictObject({ prompt: z.string(), files: z.array(z.string()), answers: z.record(z.string(), z.string()).default({}), plan_sha256: z.string(), created_at: z.string() });
const ResultFile = z.strictObject({ finished_at: z.string(), report: z.unknown().nullable(), error: z.string().nullable(), cancelled: z.boolean().default(false) });

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

/** The seats the run last resolved, from its own events; null when it has not resolved any (or the file is unreadable). */
export async function readResolvedSeats(repoDir: string, runId: string): Promise<ResolvedSeats | null> {
  let lines: string[];
  try {
    lines = (await readFile(`${runDir(repoDir, runId)}/events.jsonl`, "utf8")).split("\n").filter((l) => l !== "");
  } catch {
    return null;
  }
  let resolved: Record<string, unknown> | null = null;
  let independence: Record<string, unknown> | null = null;
  let source: string | null = null;
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { event?: unknown; data?: Record<string, unknown> };
      if (e.data === undefined) continue;
      if (e.event === "seats_resolved") resolved = e.data;
      else if (e.event === "review_independence" && e.data["role"] === "build") independence = e.data;
      else if (e.event === "config_loaded") source = typeof e.data["source"] === "string" ? e.data["source"] : null;
    } catch {
      // skip a damaged line
    }
  }
  if (resolved === null) return null;
  const pair = z.tuple([z.string(), z.string()]).safeParse(resolved["pair"]);
  const models = z.tuple([z.string().nullable(), z.string().nullable()]).safeParse(resolved["seatModels"]);
  if (!pair.success || !models.success) return null;
  const seats: [z.infer<typeof SeatShape>, z.infer<typeof SeatShape>] = [
    { provider: pair.data[0], model: models.data[0] },
    { provider: pair.data[1], model: models.data[1] },
  ];
  const seat = (v: unknown): z.infer<typeof SeatShape> | null => {
    const r = SeatShape.safeParse(v);
    return r.success ? r.data : null;
  };
  const unnamed = seats.flatMap((s, i) => (s.model === null ? [`seat ${String(i)} (${s.provider})`] : []));
  return {
    seats,
    build_author: seat(independence?.["author"]),
    build_reviewer: seat(independence?.["reviewer"]),
    review_independence: typeof independence?.["level"] === "string" ? independence["level"] : null,
    chosen_automatically: resolved["auto"] === true,
    config_source: source,
    model_note: unnamed.length === 0 ? null : `No model is named for ${unnamed.join(" and ")}, so it runs on that provider's own default model. To pin one, set providers.seatModels in osa.config.json.`,
    notes: Array.isArray(resolved["notes"]) ? resolved["notes"].filter((n): n is string => typeof n === "string") : [],
  };
}

// ---- background jobs of THIS server process -------------------------------------------------------------------------------------

interface Job {
  readonly runId: string;
  readonly repoDir: string;
  readonly startedAt: string;
  readonly promise: Promise<void>;
  /** Aborting it stops the run's child processes (see runCancelScope in util/exec.ts). */
  readonly abort: AbortController;
}
const jobs = new Map<string, Job>();
const normRepo = (d: string): string => d.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();

// Waiting gates for osa_spec: map of runId to resolve function that settles when osa_build decides.
const pendingGates = new Map<string, { resolve(approved: boolean): void }>();

/** The run ids this process is currently building. */
export function runningJobs(): string[] {
  return [...jobs.values()].map((j) => j.runId);
}

/** Forgets every job and pending gate of this process, as if the server had been restarted (tests). The run's files on disk are untouched. */
export function forgetJobsAsIfRestarted(): void {
  jobs.clear();
  pendingGates.clear();
}

/** Resolves when every background job of this process has ended (tests; also lets a clean shutdown wait). */
export async function waitForJobs(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.promise));
}

// ---- dependencies ----------------------------------------------------------------------------------------------------------------

export interface OsaToolDeps {
  /** Replaces the pipeline (tests). */
  readonly run?: typeof runOsaCommand;
  /** Extra pipeline collaborators (tests: fake model, fake research HTTP, fake preflight ...). */
  readonly pipeline?: Partial<OsaDeps>;
  /** Replaces the check that this server's compiled code is not behind the source (tests). */
  readonly buildWarning?: () => string | null;
}

const NO_TERMINAL = { show: (): void => undefined, edit: (): Promise<void> => Promise.resolve() };

/** Creates a GateIO that writes the first show() call's text as TL;DR to mcp-gate.json and returns a promise for confirm(). */
function makeWaitingGate(repoDir: string, runId: string): GateIO {
  let tldrWritten = false;
  return {
    show(text: string): void {
      // Only the FIRST call is the TL;DR (the pipeline's gate shows the PRD again afterwards). Written synchronously, so by the time confirm() makes the
      // run visible as "waiting", the file osa_status reads already exists.
      if (tldrWritten) return;
      tldrWritten = true;
      const gateFile = `${osaDir(repoDir)}/runs/${runId}/mcp-gate.json`;
      mkdirSync(dirname(gateFile), { recursive: true });
      writeFileSync(gateFile, JSON.stringify({ tldr: text.split("\n"), created_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    },
    confirm(): Promise<boolean> {
      return new Promise((resolve) => {
        // A decision removes the gate: a decided run is no longer "awaiting" anything.
        pendingGates.set(runId, {
          resolve: (approved) => {
            pendingGates.delete(runId);
            resolve(approved);
          },
        });
      });
    },
  };
}

function errorResult(err: unknown): CallToolResult {
  const text = err instanceof OsaError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  return { content: [{ type: "text", text }], isError: true };
}
function refuse(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
function ok<T extends object>(value: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

// ---- osa_plan --------------------------------------------------------------------------------------------------------------------

/** Runs intake and returns the plan. Pure of MCP types so a test can call it directly. */
export async function planOsaRun(input: PlanInput, deps: OsaToolDeps = {}): Promise<PlanOutput> {
  const run = deps.run ?? runOsaCommand;
  const baseOpts: OsaCommandOptions = { prompt: input.prompt, files: input.files, repoDir: input.repo_dir, yes: false, json: true, build: false, stopAfterPlan: true };
  const opts = Object.keys(input.answers).length > 0 ? { ...baseOpts, answers: input.answers } : baseOpts;
  const report = await run(
    opts,
    { interactive: true, io: { ...NO_TERMINAL, choose: () => Promise.resolve("cancel" as const) }, ...(deps.pipeline ?? {}) },
  );
  if (!report.ok) throw new UsageError(report.problems.join(" ") || "OSA could not make a plan.");
  const markdown = await readFile(draftPath(input.repo_dir, report.run_id), "utf8");
  const prd = parseBabyPrd(markdown);
  const sha = sha256String(markdown);
  await mkdir(runDir(input.repo_dir, report.run_id), { recursive: true });
  await writeFile(
    `${runDir(input.repo_dir, report.run_id)}/plan-request.json`,
    JSON.stringify({ prompt: input.prompt, files: input.files, answers: input.answers ?? {}, plan_sha256: sha, created_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  const risky = prd.assumptions.filter((a) => a.risk === "risky").map((a) => a.text);
  const defaulted = prd.assumptions.filter((a) => a.risk === "defaulted").map((a) => a.text);
  const safe = prd.assumptions.filter((a) => a.risk === "safe").map((a) => a.text);
  const staleBuild = (deps.buildWarning ?? buildFreshnessWarning)();
  const nextStepMain = "Show the person this plan (risky assumptions first), then after their explicit yes, call osa_spec (or call osa_plan again to refine it).";
  const nextStep = prd.recommendedQuestions.length > 0
    ? `Highly recommended: answer these questions (saves redoing a ~20 minute research and spec run): ${prd.recommendedQuestions.map(q => q.question).join("; ")}. ` +
      `Answering means calling osa_plan again with answers. ${nextStepMain}`
    : nextStepMain;
  return {
    run_id: report.run_id,
    plan_sha256: sha,
    tldr: prd.tldr.join("\n"),
    plan_markdown: markdown,
    scope: prd.scope,
    recommended_questions: prd.recommendedQuestions,
    risky_assumptions: risky,
    defaulted_assumptions: defaulted,
    safe_assumptions: safe,
    // First, so it is seen: every flow starts with osa_plan, and a stale build means the fixes in the source are not what is running.
    warnings: [...(staleBuild === null ? [] : [staleBuild]), ...report.warnings],
    next_step: nextStep,
    seats: await readResolvedSeats(input.repo_dir, report.run_id),
  };
}

type PlanRequest = z.infer<typeof PlanRequestFile>;

/** Events that mean a run's build has begun: the repository has moved on from its spec, so the run can no longer be carried on from earlier. */
const BUILD_BEGUN_EVENTS = ["build_started", "step14_done", "application_check"];

/** The event names a run has recorded, oldest first; empty when there is no log. */
async function readEventNames(repoDir: string, runId: string): Promise<string[]> {
  try {
    return (await readFile(`${runDir(repoDir, runId)}/events.jsonl`, "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as { event?: unknown };
          return typeof e.event === "string" ? [e.event] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * True when a run was stopped with osa_cancel after it had started work (its plan was locked) and before its build began. Such a run is not final:
 * osa_spec on the same run carries it on, keeping the research that finished. A discarded plan (never locked), a spec the person declined at the gate
 * (the run ended with a report, not a cancel) and a run whose build had begun are final.
 */
function cancelledBeforeBuild(result: z.infer<typeof ResultFile> | null, eventNames: readonly string[]): boolean {
  return result !== null && result.cancelled && eventNames.includes("prd_locked") && !BUILD_BEGUN_EVENTS.some((e) => eventNames.includes(e));
}

/** What to do next with a run that osa_cancel stopped before its build began; the exact arguments osa_spec needs. */
function carryOnAdvice(runId: string, request: PlanRequest): string {
  return `It can be carried on instead of redone: with the person's go-ahead, call osa_spec again with run_id ${runId} and plan_sha256 ${request.plan_sha256}. Research items that already finished are not repeated; the rest of research and the spec are run again. Or call osa_plan to start from scratch.`;
}

/**
 * Starts the pipeline for a run as a background job of this process and records its result when it ends. With `resume`, the pipeline skips intake,
 * research and spec and carries on from the post-spec gate using the state saved there (see osa/resume-state.ts).
 */
function launchRunJob(a: { readonly repoDir: string; readonly runId: string; readonly request: PlanRequest; readonly resume: boolean; readonly resumeBuild?: boolean; readonly gateIo: GateIO; readonly deps: OsaToolDeps }): void {
  const run = a.deps.run ?? runOsaCommand;
  const startedAt = new Date().toISOString();
  const resultPath = `${runDir(a.repoDir, a.runId)}/mcp-result.json`;
  const abort = new AbortController();
  let job: Job | undefined;
  // After a cancel the run's gate answers "declined" at once: a pipeline that reaches the gate late must not park there.
  const gateIo: GateIO = { show: (text) => a.gateIo.show(text), confirm: () => (abort.signal.aborted ? Promise.resolve(false) : a.gateIo.confirm()) };

  const promise = (async (): Promise<void> => {
    let report: OsaRunReport | null = null;
    let error: string | null = null;
    try {
      const baseOpts: OsaCommandOptions = {
        prompt: a.request.prompt,
        files: a.request.files,
        repoDir: a.repoDir,
        yes: false,
        json: true,
        build: true,
        fromDraft: true,
        ...(a.resume ? { fromSpec: true } : {}),
        ...(a.resumeBuild === true ? { resumeBuild: true } : {}),
      };
      const opts = Object.keys(a.request.answers ?? {}).length > 0 ? { ...baseOpts, answers: a.request.answers } : baseOpts;
      report = await runCancelScope(abort.signal, () =>
        run(
          opts,
          { runId: a.runId, interactive: true, io: { ...NO_TERMINAL, choose: () => Promise.resolve("lock" as const) }, gateIo, ...(a.deps.pipeline ?? {}) },
        ),
      );
    } catch (err) {
      error = err instanceof OsaError ? err.message : err instanceof Error ? err.message : String(err);
    }
    // A job that osa_cancel gave up on (see abandonJob) is no longer the live job of this run: a run may have been carried on since, so this late
    // finish must not write its result, drop its entry or answer its gate.
    if (job !== undefined && jobs.get(a.runId) !== job) return;
    try {
      // A cancel wins over whatever the pipeline reported as it unwound (usually a RunCancelledError or a killed turn).
      const cancelled = abort.signal.aborted;
      await writeFile(resultPath, JSON.stringify({ finished_at: new Date().toISOString(), report: cancelled ? null : report, error: cancelled ? null : error, cancelled }, null, 2) + "\n", "utf8");
    } finally {
      jobs.delete(a.runId);
      // The pipeline has ended: nothing can be waiting on this gate any more (a still-pending one means it threw before the decision).
      pendingGates.get(a.runId)?.resolve(false);
      pendingGates.delete(a.runId);
    }
  })();

  job = { runId: a.runId, repoDir: a.repoDir, startedAt, promise, abort };
  jobs.set(a.runId, job);
}

/**
 * The saved state of a run that was lost while it waited at the post-spec gate (the server restarted, so its in-memory gate is gone), or null when
 * the run is not in that situation: still alive here, already decided, never reached the gate, or already building (a build interrupted part-way is
 * not carried on from the gate, because the repository has moved on).
 */
async function resumableState(repoDir: string, runId: string): Promise<ResumeState | null> {
  return savedRunState(repoDir, runId, false);
}

/**
 * The saved state of a run whose BUILD had begun when it was lost (no result, no live job here), or null. osa_build carries it on from the phase after
 * the last one that finished (see osa/build-resume.ts). A run stopped with osa_cancel has a result, so it is not offered: that stop was deliberate.
 */
async function resumableBuild(repoDir: string, runId: string): Promise<ResumeState | null> {
  return savedRunState(repoDir, runId, true);
}

async function savedRunState(repoDir: string, runId: string, buildBegun: boolean): Promise<ResumeState | null> {
  if (pendingGates.has(runId) || jobs.has(runId)) return null;
  if ((await readJson(`${runDir(repoDir, runId)}/mcp-result.json`, ResultFile)) !== null) return null;
  const state = await readResumeState(repoDir, runId);
  if (state === null) return null;
  try {
    await stat(specGateRecordPath(repoDir, runId));
    const events = (await readFile(`${runDir(repoDir, runId)}/events.jsonl`, "utf8")).split("\n");
    if (events.some((l) => l.includes('"event":"build_started"')) !== buildBegun) return null;
  } catch {
    return null;
  }
  return state;
}

// ---- osa_spec -------------------------------------------------------------------------------------------------------------------

/** Starts research and spec as a background job, waiting at the post-spec gate for approval. */
export async function startOsaSpec(input: SpecInput, deps: OsaToolDeps = {}): Promise<SpecOutput | { readonly refusal: string }> {
  const request = await readJson(`${runDir(input.repo_dir, input.run_id)}/plan-request.json`, PlanRequestFile);
  if (request === null) return { refusal: `There is no plan for run ${input.run_id} in ${input.repo_dir}. Call osa_plan first.` };
  if (input.plan_sha256 !== request.plan_sha256) {
    return { refusal: `The plan_sha256 does not match the plan in the request file: either it is not the plan the person was shown, or the plan file changed after it was shown. Nothing was started. Call osa_plan again and show the person the new plan.` };
  }
  if (pendingGates.has(input.run_id) || [...jobs.values()].some((j) => j.runId === input.run_id)) {
    return { refusal: `Run ${input.run_id} is already waiting for a decision or is running. Use osa_status to see it, or osa_plan for a new plan.` };
  }
  const result = await readJson(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, ResultFile);
  // A run that osa_cancel stopped before its build began is not final: "go" carries it on (see cancelledBeforeBuild).
  const carryingOn = result !== null && input.decision === "go" && cancelledBeforeBuild(result, await readEventNames(input.repo_dir, input.run_id));
  if (result !== null && !carryingOn) {
    return { refusal: `Run ${input.run_id} was already decided or is already running. Use osa_status to see it, or osa_plan for a new plan.` };
  }

  if (input.decision === "cancel") {
    await writeFile(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, JSON.stringify({ finished_at: new Date().toISOString(), report: null, error: null, cancelled: true }, null, 2) + "\n", "utf8");
    return { run_id: input.run_id, status: "cancelled", message: "Plan discarded; nothing was built." };
  }

  const busy = [...jobs.values()].find((j) => normRepo(j.repoDir) === normRepo(input.repo_dir));
  if (busy !== undefined) return { refusal: `Run ${busy.runId} is still working in this repository (started ${busy.startedAt}). Wait for it to end (osa_status) before starting another.` };

  if (carryingOn) {
    // Keep the record of the cancel beside the run; the run is live again.
    await rename(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, `${runDir(input.repo_dir, input.run_id)}/mcp-result.cancelled.json`);
  }
  launchRunJob({ repoDir: input.repo_dir, runId: input.run_id, request, resume: false, gateIo: makeWaitingGate(input.repo_dir, input.run_id), deps });
  return {
    run_id: input.run_id,
    status: "started",
    message: (carryingOn ? "The cancelled run is carried on; research that finished before the cancel is kept. " : "") + "Research and spec are running in the background (typically 15 to 20 minutes). Follow progress with osa_status, and once the spec is ready, call osa_build. The providers and models it resolved are shown by osa_status (seats) as soon as the job starts.",
  };
}

// ---- osa_build -------------------------------------------------------------------------------------------------------------------

/**
 * Releases the run that is waiting at the post-spec gate (started by osa_spec). The decision is bound to the spec the person was shown: the
 * spec_sha256 must equal the one recorded when the spec was written AND the one recomputed from the spec files on disk now, so a confirmation
 * cannot be applied to a spec that changed after it was shown. "lock" lets the pipeline carry on into the build in the same background job.
 */
export async function startOsaBuild(input: BuildInput, deps: OsaToolDeps = {}): Promise<BuildOutput | { readonly refusal: string }> {
  const gate = pendingGates.get(input.run_id);
  // No gate in memory: the run may have been lost to a server restart while it waited, with its spec and saved state on disk. It is then carried on
  // from the gate, in a new job, instead of being redone.
  const resumed = gate === undefined ? await resumableState(input.repo_dir, input.run_id) : null;
  // Or the build had already begun: it is carried on from the phase after the last one that finished.
  const resumedBuild = gate === undefined && resumed === null ? await resumableBuild(input.repo_dir, input.run_id) : null;
  if (gate === undefined && resumed === null && resumedBuild === null) {
    return { refusal: `No spec is waiting for a decision for run ${input.run_id}. Call osa_plan, then osa_spec, and wait until osa_status shows awaiting_confirmation at stage spec. (A run whose build had begun when the MCP server stopped can be carried on only if it has a saved spec and was not stopped with osa_cancel; otherwise start again with osa_plan.)` };
  }
  let recorded: SpecGateRecord;
  try {
    recorded = SpecGateRecord.parse(JSON.parse(await readFile(specGateRecordPath(input.repo_dir, input.run_id), "utf8")));
  } catch {
    return { refusal: `The spec record for run ${input.run_id} is missing or unreadable, so the spec cannot be confirmed. Nothing was built.` };
  }
  // Before the build the whole spec folder must be as it was shown; once a build has begun it also holds later phases' specs, so only the approved files
  // themselves are compared.
  const specIntact = resumedBuild !== null ? (await changedApprovedSpecFiles(input.repo_dir, recorded)).length === 0 : (await buildSpecManifest(input.repo_dir, input.run_id)).gateHash === recorded.spec_gate_sha256;
  if (input.spec_sha256 !== recorded.spec_gate_sha256 || !specIntact) {
    return { refusal: "The spec_sha256 does not match: either it is not the spec the person was shown, or a spec file changed after it was shown. Nothing was built. Read osa_status again and show the person the TL;DR it reports." };
  }
  if (input.decision === "cancel") {
    if (gate !== undefined) {
      gate.resolve(false);
    } else {
      await writeFile(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, JSON.stringify({ finished_at: new Date().toISOString(), report: null, error: null, cancelled: true }, null, 2) + "\n", "utf8");
    }
    return { run_id: input.run_id, status: "cancelled", message: "The spec was declined; nothing was built. The research and spec are kept under runs/ for reference.", seats: null };
  }
  let risky: string[] = [];
  try {
    risky = parseBabyPrd(await readFile(draftPath(input.repo_dir, input.run_id), "utf8")).assumptions.filter((a) => a.risk === "risky").map((a) => a.text);
  } catch {
    return { refusal: `The plan file for run ${input.run_id} is missing, so its risky assumptions cannot be checked. Nothing was built.` };
  }
  if (risky.length > 0 && !input.accept_risky_assumptions) {
    return { refusal: `The plan has ${String(risky.length)} risky assumption(s) that the person must accept explicitly before the build starts:\n${risky.map((a) => `- ${a}`).join("\n")}\nShow them, and call osa_build again with accept_risky_assumptions true only if the person accepts them.` };
  }
  if (gate !== undefined) {
    gate.resolve(true);
  } else {
    const request = await readJson(`${runDir(input.repo_dir, input.run_id)}/plan-request.json`, PlanRequestFile);
    if (request === null) return { refusal: `The plan request for run ${input.run_id} is missing, so it cannot be carried on. Nothing was built.` };
    const busy = [...jobs.values()].find((j) => normRepo(j.repoDir) === normRepo(input.repo_dir));
    if (busy !== undefined) return { refusal: `Run ${busy.runId} is still working in this repository (started ${busy.startedAt}). Wait for it to end (osa_status) before starting another.` };
    // The person's yes is this call (spec hash and risky assumptions checked above), so the carried-on run's gate approves at once.
    launchRunJob({ repoDir: input.repo_dir, runId: input.run_id, request, resume: true, resumeBuild: resumedBuild !== null, gateIo: { show: (): void => undefined, confirm: () => Promise.resolve(true) }, deps });
  }
  const finishedBefore = resumedBuild !== null ? await lastFinishedPhase(input.repo_dir, input.run_id) : 0;
  return {
    run_id: input.run_id,
    status: "started",
    message: gate !== undefined
      ? "The spec is confirmed and the build is running in the background (typically 30 to 60 minutes, then a final check). Follow it with osa_status."
      : resumedBuild !== null
        ? `The build is carried on: ${finishedBefore === 0 ? "no phase had finished, so it restarts from phase 1" : `phases 1 to ${String(finishedBefore)} had finished and are kept`}; work left by the interrupted phase is folded back and that phase is redone. It is running in the background (a phase takes a few minutes, then a final check). Follow it with osa_status.`
        : "The spec is confirmed. The server had restarted since the spec was written, so the run is carried on from its saved spec (the research and spec are not repeated) and the build is running in the background (typically 30 to 60 minutes, then a final check). Follow it with osa_status.",
    seats: await readResolvedSeats(input.repo_dir, input.run_id),
  };
}

// ---- osa_cancel ------------------------------------------------------------------------------------------------------------------

/** How long osa_cancel waits for the job to finish unwinding before it answers anyway. */
const CANCEL_WAIT_MS = 15_000;

/** Records the run as cancelled and takes its job off the table, for a job that did not unwind after osa_cancel. */
async function abandonJob(job: Job, repoDir: string): Promise<void> {
  await writeFile(`${runDir(repoDir, job.runId)}/mcp-result.json`, JSON.stringify({ finished_at: new Date().toISOString(), report: null, error: null, cancelled: true }, null, 2) + "\n", "utf8");
  jobs.delete(job.runId);
  pendingGates.get(job.runId)?.resolve(false);
  pendingGates.delete(job.runId);
}

/**
 * Stops a run this process is working on: aborts its child processes, declines its pending gate, and waits (briefly) for the job to record the
 * cancelled result. Nothing already committed is undone.
 */
export async function cancelOsaRun(input: CancelInput, opts: { readonly waitMs?: number } = {}): Promise<CancelOutput> {
  const job = jobs.get(input.run_id);
  if (job === undefined || normRepo(job.repoDir) !== normRepo(input.repo_dir)) {
    return {
      run_id: input.run_id,
      status: "not_running",
      message: "This server process is not working on that run, so there is nothing to stop. If it shows as interrupted, the process that ran it is gone; check osa_status.",
    };
  }
  job.abort.abort();
  // A run parked at the post-spec gate has no child process to kill: release it as declined so its job can end.
  pendingGates.get(input.run_id)?.resolve(false);
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    job.promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), opts.waitMs ?? CANCEL_WAIT_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!ended) {
    // The job is stuck on something the abort cannot interrupt (not a child process: a hung network request, say). Leaving it on the table would keep
    // the repository "busy" and the run "running" until the server restarted, so the cancel is made final here and the job abandoned: when it does
    // unwind it finds it is no longer the live job and does nothing (see launchRunJob).
    await abandonJob(job, input.repo_dir);
    return {
      run_id: input.run_id,
      status: "cancelled",
      message:
        "The stop was sent and the agent processes were killed, but one step that is not an agent process did not stop. The run is recorded as cancelled and the repository is free for a new run; the stuck step may finish in the background but can start nothing further.",
    };
  }
  let carryOn = "";
  if (ended) {
    const request = await readJson(`${runDir(input.repo_dir, input.run_id)}/plan-request.json`, PlanRequestFile);
    const result = await readJson(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, ResultFile);
    if (request !== null && cancelledBeforeBuild(result, await readEventNames(input.repo_dir, input.run_id))) carryOn = ` The build had not begun. ${carryOnAdvice(input.run_id, request)}`;
  }
  return {
    run_id: input.run_id,
    status: "cancelled",
    message: `The run was stopped. Work already committed to the repository stays; research and spec files are kept under runs/.${carryOn}`,
  };
}

// ---- osa_status ------------------------------------------------------------------------------------------------------------------

const STAGE_OF: Readonly<Record<string, string>> = {
  assumptions_generated: "plan",
  prd_locked: "locked",
  research_routed: "research",
  research_item_done: "research",
  research_validated: "research",
  research_crosscheck: "research",
  spec_written: "spec",
  spec_gate_written: "spec",
  lateral_arch_done: "agents",
  implication_done: "agents",
  step14_done: "build",
  application_check: "verify",
  token_breakdown: "summary",
  memory_written: "summary",
};

async function latestRunId(repoDir: string): Promise<string | null> {
  try {
    const dir = `${osaDir(repoDir)}/runs`;
    const entries = await readdir(dir);
    let best: { id: string; t: number } | null = null;
    for (const id of entries) {
      try {
        const t = (await stat(`${dir}/${id}`)).mtimeMs;
        if (best === null || t > best.t) best = { id, t };
      } catch {
        // skip
      }
    }
    return best?.id ?? null;
  } catch {
    return null;
  }
}

/** The state of one run, from its own files plus this process's job table. */
export async function osaRunStatus(input: StatusInput): Promise<StatusOutput | { readonly refusal: string }> {
  const status = await runStatusWithoutSeats(input);
  if ("refusal" in status) return status;
  return { ...status, seats: await readResolvedSeats(input.repo_dir, status.run_id) };
}

async function runStatusWithoutSeats(input: StatusInput): Promise<Omit<StatusOutput, "seats"> | { readonly refusal: string }> {
  const runId = input.run_id ?? (await latestRunId(input.repo_dir));
  if (runId === null) return { refusal: `No OSA run found in ${input.repo_dir}.` };
  const dir = runDir(input.repo_dir, runId);
  let lines: string[] = [];
  try {
    lines = (await readFile(`${dir}/events.jsonl`, "utf8")).split("\n").filter((l) => l !== "");
  } catch {
    // no events yet
  }
  const events: { at: string; event: string }[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { at?: unknown; event?: unknown };
      if (typeof e.at === "string" && typeof e.event === "string") events.push({ at: e.at, event: e.event });
    } catch {
      // skip a damaged line
    }
  }
  const recent = events.slice(-6);
  let stage = "plan";
  for (const e of events) stage = STAGE_OF[e.event] ?? stage;
  const result = await readJson(`${dir}/mcp-result.json`, ResultFile);
  const request = await readJson(`${dir}/plan-request.json`, PlanRequestFile);
  const running = [...jobs.values()].some((j) => j.runId === runId);

  // Check for spec gate: if pending and mcp-gate.json exists, return awaiting_confirmation. A run lost to a server restart while it waited here is
  // shown the same way: its saved spec is intact and osa_build carries it on (see resumableState).
  const restarted = pendingGates.has(runId) ? null : await resumableState(input.repo_dir, runId);
  if (pendingGates.has(runId) || restarted !== null) {
    try {
      const gateFileContent = await readFile(`${dir}/mcp-gate.json`, "utf8");
      const gateData = JSON.parse(gateFileContent) as { tldr?: string[] };
      const tldr = gateData.tldr ?? restarted?.tldr ?? [];

      // Read the spec-gate.json to get spec_sha256 and extract risky/defaulted assumptions
      let specSha256: string | null = null;
      let risky: string[] = [];
      let defaulted: string[] = [];

      try {
        const specGateRecord = await readJson(specGateRecordPath(input.repo_dir, runId), SpecGateRecord);
        if (specGateRecord) specSha256 = specGateRecord.spec_gate_sha256;
      } catch {
        // no spec gate yet
      }

      // Read the baby-prd to get risky and defaulted assumptions
      try {
        const markdown = await readFile(`${input.repo_dir}/runs/${runId}/baby-prd.md`, "utf8");
        const prd = parseBabyPrd(markdown);
        risky = prd.assumptions.filter((a) => a.risk === "risky").map((a) => a.text);
        defaulted = prd.assumptions.filter((a) => a.risk === "defaulted").map((a) => a.text);
      } catch {
        // no prd yet
      }

      return {
        run_id: runId,
        state: "awaiting_confirmation",
        stage: "spec",
        message: (restarted !== null ? "The server was restarted since this spec was written; its research and spec were kept, so approving it carries on without repeating them.\n\n" : "") + tldr.join("\n"),
        recent_events: recent,
        report: null,
        summary_markdown: null,
        tldr,
        spec_sha256: specSha256,
        risky_assumptions: risky,
        defaulted_assumptions: defaulted,
      };
    } catch {
      // mcp-gate.json doesn't exist yet, treat as running
    }
  }

  if (result !== null) {
    const report = result.report as (Partial<OsaRunReport> & { summary_path?: string | null }) | null;
    let summary: string | null = null;
    if (report?.summary_path != null) {
      try {
        summary = (await readFile(`${input.repo_dir}/${report.summary_path}`, "utf8")).slice(0, 8000);
      } catch {
        summary = null;
      }
    }
    const startedWork = events.some((e) => e.event === "prd_locked");
    const carryOn = request !== null && cancelledBeforeBuild(result, events.map((e) => e.event)) ? ` ${carryOnAdvice(runId, request)}` : "";
    if (result.cancelled) return { run_id: runId, state: "cancelled", stage: startedWork ? stage : "plan", message: startedWork ? `The run was cancelled during the ${stage} stage. Work already committed stays in the repository; research and spec files are kept under runs/.${carryOn}` : "The plan was discarded; nothing was built.", recent_events: recent, report: null, summary_markdown: null, tldr: null, spec_sha256: null, risky_assumptions: [], defaulted_assumptions: [] };
    if (result.error !== null) return { run_id: runId, state: "stopped", stage, message: `The run stopped with an error: ${result.error}`, recent_events: recent, report: null, summary_markdown: null, tldr: null, spec_sha256: null, risky_assumptions: [], defaulted_assumptions: [] };
    const good = report?.ok === true;
    return {
      run_id: runId,
      state: good ? "finished" : "stopped",
      stage: report?.stage ?? stage,
      message: good ? "The run finished. The report and the plain-language summary are attached." : `The run stopped: ${(report?.problems ?? []).join(" ") || "see the report"}`,
      recent_events: recent,
      report: result.report,
      summary_markdown: summary,
      tldr: null,
      spec_sha256: null,
      risky_assumptions: [],
      defaulted_assumptions: [],
    };
  }
  if (running) return { run_id: runId, state: "running", stage, message: `Building. Last stage reached: ${stage}. Check again in a few minutes.`, recent_events: recent, report: null, summary_markdown: null, tldr: null, spec_sha256: null, risky_assumptions: [], defaulted_assumptions: [] };
  const locked = events.some((e) => e.event === "prd_locked");
  if (request !== null && !locked) {
    return { run_id: runId, state: "awaiting_confirmation", stage: "plan", message: "A plan exists but has not been locked. Call osa_spec to start research and spec, or call osa_plan again to refine it.", recent_events: recent, report: null, summary_markdown: null, tldr: null, spec_sha256: null, risky_assumptions: [], defaulted_assumptions: [] };
  }
  if (events.length === 0) return { refusal: `Run ${runId} has no events in ${input.repo_dir}.` };
  // Lost before its build began and its plan is still on file: osa_spec on the same run carries it on (the research that finished is kept, only the
  // rest is redone), so starting over would throw away work. A build that had begun is different: the repository has moved on.
  const buildBegun = events.some((e) => e.event === "build_started") || stage === "build" || stage === "verify" || stage === "summary";
  if (request !== null && !buildBegun) {
    return {
      run_id: runId,
      state: "interrupted",
      stage,
      message:
        `The run stopped at the ${stage} stage without recording a result (the MCP server was probably restarted, the process was killed, or a step hung). ` +
        `Its plan and the work finished so far are kept, and the build had not begun, so it can be carried on instead of redone: with the person's go-ahead, call osa_spec again with ` +
        `run_id ${runId} and plan_sha256 ${request.plan_sha256}. Research items that already finished are not repeated; the rest of research and the spec are run again.`,
      recent_events: recent,
      report: null,
      summary_markdown: null,
      tldr: null,
      spec_sha256: null,
      risky_assumptions: [],
      defaulted_assumptions: [],
    };
  }
  const buildState = await resumableBuild(input.repo_dir, runId);
  if (buildState !== null) {
    const recorded = await readJson(specGateRecordPath(input.repo_dir, runId), SpecGateRecord);
    const finished = await lastFinishedPhase(input.repo_dir, runId);
    return {
      run_id: runId,
      state: "interrupted",
      stage: "build",
      message:
        `The build was interrupted after ${finished === 0 ? "no finished phase" : `phase ${String(finished)} of ${String(buildState.spec.totalPhases)}`} (the MCP server was probably restarted, or the process was killed). It can be carried on instead of redone: ` +
        `with the person's go-ahead, call osa_build with run_id ${runId}, decision "lock" and the spec_sha256 below (accept_risky_assumptions true only if the person accepted the plan's risky assumptions). ` +
        `The phases already built are kept; work left by the interrupted phase is folded back so the reviewer still sees it, and that phase is redone.`,
      recent_events: recent,
      report: null,
      summary_markdown: null,
      tldr: null,
      spec_sha256: recorded?.spec_gate_sha256 ?? null,
      risky_assumptions: [],
      defaulted_assumptions: [],
    };
  }
  return {
    run_id: runId,
    state: "interrupted",
    stage,
    message: "The run stopped without recording a result (the MCP server was probably restarted, or the process was killed) after its build had begun, or without a saved plan to carry on from. Its files up to the last stage are under runs/ and .osa/runs/; start again with osa_plan.",
    recent_events: recent,
    report: null,
    summary_markdown: null,
    tldr: null,
    spec_sha256: null,
    risky_assumptions: [],
    defaulted_assumptions: [],
  };
}

// ---- registration ----------------------------------------------------------------------------------------------------------------

/** Registers osa_plan, osa_spec, osa_build, osa_cancel and osa_status. */
export function registerOsaTools(server: McpServer, deps: OsaToolDeps = {}): void {
  server.registerTool("osa_plan", { description: PLAN_TOOL_DESCRIPTION, inputSchema: PlanInput, outputSchema: PlanOutput }, async (input) => {
    try {
      return ok(await planOsaRun(input, deps));
    } catch (err) {
      return errorResult(err);
    }
  });
  server.registerTool("osa_spec", { description: SPEC_TOOL_DESCRIPTION, inputSchema: SpecInput, outputSchema: SpecOutput }, async (input) => {
    try {
      const r = await startOsaSpec(input, deps);
      return "refusal" in r ? refuse(r.refusal) : ok(r);
    } catch (err) {
      return errorResult(err);
    }
  });
  server.registerTool("osa_build", { description: BUILD_TOOL_DESCRIPTION, inputSchema: BuildInput, outputSchema: BuildOutput }, async (input) => {
    try {
      const r = await startOsaBuild(input, deps);
      return "refusal" in r ? refuse(r.refusal) : ok(r);
    } catch (err) {
      return errorResult(err);
    }
  });
  server.registerTool("osa_cancel", { description: CANCEL_TOOL_DESCRIPTION, inputSchema: CancelInput, outputSchema: CancelOutput }, async (input) => {
    try {
      return ok(await cancelOsaRun(input));
    } catch (err) {
      return errorResult(err);
    }
  });
  server.registerTool("osa_status", { description: STATUS_TOOL_DESCRIPTION, inputSchema: StatusInput, outputSchema: StatusOutput }, async (input) => {
    try {
      const r = await osaRunStatus(input);
      return "refusal" in r ? refuse(r.refusal) : ok(r);
    } catch (err) {
      return errorResult(err);
    }
  });
}
