// The one-shot flow as MCP tools: osa_plan -> (the person confirms, in their own chat) -> osa_build -> osa_status.
//
// The CLI asks for the lock in a terminal. An MCP client has no terminal, so the lock becomes two tool calls with the person's yes in between:
//   osa_plan    runs intake only and returns the plan (TL;DR, criteria, tagged assumptions) plus a fingerprint of exactly that plan. Nothing is locked.
//   osa_build   locks THAT plan (the fingerprint must match the file on disk, so the plan locked is the plan shown) and runs the whole pipeline in the
//               background of the MCP server process; it returns at once, because a build takes tens of minutes and a tool call must not.
//   osa_status  reads the run's own files, so it also works after the server restarted (a job lost with the process is reported as "interrupted").
// The tool descriptions tell the calling assistant to show the plan and get an explicit yes; the server additionally refuses a plan whose risky
// assumptions were not explicitly accepted, and a fingerprint that does not match, so a confirmation cannot be applied to a different plan.

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError, UsageError } from "../../domain/errors.ts";
import { parseBabyPrd } from "../../osa/baby-prd.ts";
import type { OsaDeps, OsaRunReport } from "../../osa/pipeline.ts";
import { runOsaCommand } from "../../osa/pipeline.ts";
import { sha256String } from "../../util/hash.ts";
import { osaDir } from "../../util/paths.ts";

// ---- schemas ---------------------------------------------------------------------------------------------------------------------

export const PlanInput = z.strictObject({
  /** The repository to build in: an existing git repository with at least one commit. */
  repo_dir: z.string().min(1),
  /** What the person wants built, in their own words. */
  prompt: z.string().trim().min(1).max(40_000),
  /** Optional files (repo-relative or absolute) whose content is given to the planner as context. */
  files: z.array(z.string().min(1)).max(20).default([]),
});
export type PlanInput = z.infer<typeof PlanInput>;

export const PlanOutput = z.strictObject({
  run_id: z.uuid(),
  /** Fingerprint of exactly this plan; osa_build must echo it. */
  plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  tldr: z.string(),
  /** The whole plan as markdown: problem, scope, acceptance criteria, constraints, research plan, assumptions. */
  plan_markdown: z.string(),
  /** Assumptions OSA made that would change scope, architecture, data handling, cost or security if wrong. Show these first. */
  risky_assumptions: z.array(z.string()),
  safe_assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  next_step: z.string(),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const BuildInput = z.strictObject({
  repo_dir: z.string().min(1),
  run_id: z.uuid(),
  /** The plan_sha256 returned by osa_plan for the plan the person approved. */
  plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** "lock" = the person approved this plan; "cancel" = they did not. */
  decision: z.enum(["lock", "cancel"]),
  /** Required to be true when the plan lists risky assumptions: only after the person has read and accepted each one. */
  accept_risky_assumptions: z.boolean().default(false),
  /** Stop after the research and the spec; do not build. */
  spec_only: z.boolean().default(false),
});
export type BuildInput = z.infer<typeof BuildInput>;

export const BuildOutput = z.strictObject({
  run_id: z.uuid(),
  status: z.enum(["started", "cancelled"]),
  message: z.string(),
});
export type BuildOutput = z.infer<typeof BuildOutput>;

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
});
export type StatusOutput = z.infer<typeof StatusOutput>;

export const PLAN_TOOL_DESCRIPTION =
  "Step 1 of OSA's one-shot build. Turns a request into a plain-language plan (TL;DR, scope, acceptance criteria, tagged assumptions) and writes it " +
  "into the repository. NOTHING is built or locked. You MUST show the person the plan (risky assumptions first) and ask whether to lock it. Never call " +
  "osa_build without their explicit yes. Takes about a minute.";
export const BUILD_TOOL_DESCRIPTION =
  "Step 2 of OSA's one-shot build. Only after the person has approved the plan from osa_plan: locks exactly that plan (pass the run_id and plan_sha256 " +
  "osa_plan returned) and runs research, spec, build and a final check in the background. Typically 15 to 60 minutes. Returns immediately; follow " +
  "progress with osa_status. If the plan has risky assumptions, set accept_risky_assumptions to true only after the person has read and accepted them. " +
  "decision \"cancel\" discards the plan.";
export const STATUS_TOOL_DESCRIPTION =
  "Progress and result of an OSA run: its state (awaiting_confirmation, running, finished, stopped, cancelled, interrupted), the stage, recent events, and, " +
  "once it has ended, the report and the plain-language summary. Poll it every few minutes while a build runs; a run takes tens of minutes.";

// ---- files of one run --------------------------------------------------------------------------------------------------------------

const runDir = (repoDir: string, runId: string): string => `${osaDir(repoDir)}/runs/${runId}`;
const draftPath = (repoDir: string, runId: string): string => `${repoDir}/runs/${runId}/baby-prd.md`;

const PlanRequestFile = z.strictObject({ prompt: z.string(), files: z.array(z.string()), plan_sha256: z.string(), created_at: z.string() });
const ResultFile = z.strictObject({ finished_at: z.string(), report: z.unknown().nullable(), error: z.string().nullable(), cancelled: z.boolean().default(false) });

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

// ---- background jobs of THIS server process -------------------------------------------------------------------------------------

interface Job {
  readonly runId: string;
  readonly repoDir: string;
  readonly startedAt: string;
  readonly promise: Promise<void>;
}
const jobs = new Map<string, Job>();
const normRepo = (d: string): string => d.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();

/** The run ids this process is currently building. */
export function runningJobs(): string[] {
  return [...jobs.values()].map((j) => j.runId);
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
}

const NO_TERMINAL = { show: (): void => undefined, edit: (): Promise<void> => Promise.resolve() };

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
  const report = await run(
    { prompt: input.prompt, files: input.files, repoDir: input.repo_dir, yes: false, json: true, build: false, stopAfterPlan: true },
    { interactive: true, io: { ...NO_TERMINAL, choose: () => Promise.resolve("cancel" as const) }, ...(deps.pipeline ?? {}) },
  );
  if (!report.ok) throw new UsageError(report.problems.join(" ") || "OSA could not make a plan.");
  const markdown = await readFile(draftPath(input.repo_dir, report.run_id), "utf8");
  const prd = parseBabyPrd(markdown);
  const sha = sha256String(markdown);
  await mkdir(runDir(input.repo_dir, report.run_id), { recursive: true });
  await writeFile(
    `${runDir(input.repo_dir, report.run_id)}/plan-request.json`,
    JSON.stringify({ prompt: input.prompt, files: input.files, plan_sha256: sha, created_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  const risky = prd.assumptions.filter((a) => a.risk === "risky").map((a) => a.text);
  const safe = prd.assumptions.filter((a) => a.risk !== "risky").map((a) => a.text);
  return {
    run_id: report.run_id,
    plan_sha256: sha,
    tldr: prd.tldr.join("\n"),
    plan_markdown: markdown,
    risky_assumptions: risky,
    safe_assumptions: safe,
    warnings: [...report.warnings],
    next_step:
      "Show the person this plan, risky assumptions first, and ask: lock it and build, change it, or cancel? Only on an explicit yes call osa_build with this run_id, " +
      `plan_sha256, decision "lock"${risky.length > 0 ? " and accept_risky_assumptions true (after they have accepted each risky assumption)" : ""}. To change the plan, call osa_plan again with a refined request.`,
  };
}

// ---- osa_build -------------------------------------------------------------------------------------------------------------------

/** Locks the approved plan and starts the pipeline in the background. */
export async function startOsaBuild(input: BuildInput, deps: OsaToolDeps = {}): Promise<BuildOutput | { readonly refusal: string }> {
  const request = await readJson(`${runDir(input.repo_dir, input.run_id)}/plan-request.json`, PlanRequestFile);
  if (request === null) return { refusal: `There is no plan for run ${input.run_id} in ${input.repo_dir}. Call osa_plan first.` };
  if ((await readJson(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, ResultFile)) !== null || [...jobs.values()].some((j) => j.runId === input.run_id)) {
    return { refusal: `Run ${input.run_id} was already decided or is already running. Use osa_status to see it, or osa_plan for a new plan.` };
  }
  let markdown: string;
  try {
    markdown = await readFile(draftPath(input.repo_dir, input.run_id), "utf8");
  } catch {
    return { refusal: `The plan file for run ${input.run_id} is missing; call osa_plan again.` };
  }
  const sha = sha256String(markdown);
  if (sha !== input.plan_sha256 || sha !== request.plan_sha256) {
    return { refusal: "The plan_sha256 does not match the plan on disk: either it is not the plan the person was shown, or the plan file changed after it was shown. Nothing was locked. Call osa_plan again and show the person the new plan." };
  }
  if (input.decision === "cancel") {
    await writeFile(`${runDir(input.repo_dir, input.run_id)}/mcp-result.json`, JSON.stringify({ finished_at: new Date().toISOString(), report: null, error: null, cancelled: true }, null, 2) + "\n", "utf8");
    return { run_id: input.run_id, status: "cancelled", message: "Plan discarded; nothing was built." };
  }
  const risky = parseBabyPrd(markdown).assumptions.filter((a) => a.risk === "risky");
  if (risky.length > 0 && !input.accept_risky_assumptions) {
    return { refusal: `The plan has ${String(risky.length)} risky assumption(s) that the person must accept explicitly before it is locked:\n${risky.map((a) => `- ${a.text}`).join("\n")}\nShow them, and call osa_build again with accept_risky_assumptions true only if the person accepts them.` };
  }
  const busy = [...jobs.values()].find((j) => normRepo(j.repoDir) === normRepo(input.repo_dir));
  if (busy !== undefined) return { refusal: `Run ${busy.runId} is still building in this repository (started ${busy.startedAt}). Wait for it to end (osa_status) before starting another.` };

  const run = deps.run ?? runOsaCommand;
  const startedAt = new Date().toISOString();
  const resultPath = `${runDir(input.repo_dir, input.run_id)}/mcp-result.json`;
  const promise = (async (): Promise<void> => {
    let report: OsaRunReport | null = null;
    let error: string | null = null;
    try {
      report = await run(
        { prompt: request.prompt, files: request.files, repoDir: input.repo_dir, yes: false, json: true, build: !input.spec_only, fromDraft: true },
        { runId: input.run_id, interactive: true, io: { ...NO_TERMINAL, choose: () => Promise.resolve("lock" as const) }, ...(deps.pipeline ?? {}) },
      );
    } catch (err) {
      error = err instanceof OsaError ? err.message : err instanceof Error ? err.message : String(err);
    }
    try {
      await writeFile(resultPath, JSON.stringify({ finished_at: new Date().toISOString(), report, error, cancelled: false }, null, 2) + "\n", "utf8");
    } finally {
      jobs.delete(input.run_id);
    }
  })();
  jobs.set(input.run_id, { runId: input.run_id, repoDir: input.repo_dir, startedAt, promise });
  return {
    run_id: input.run_id,
    status: "started",
    message: "The plan is locked and the build is running in the background (research, spec, build, final check; typically 15 to 60 minutes). Follow it with osa_status.",
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
    if (result.cancelled) return { run_id: runId, state: "cancelled", stage: "plan", message: "The plan was discarded; nothing was built.", recent_events: recent, report: null, summary_markdown: null };
    if (result.error !== null) return { run_id: runId, state: "stopped", stage, message: `The run stopped with an error: ${result.error}`, recent_events: recent, report: null, summary_markdown: null };
    const good = report?.ok === true;
    return {
      run_id: runId,
      state: good ? "finished" : "stopped",
      stage: report?.stage ?? stage,
      message: good ? "The run finished. The report and the plain-language summary are attached." : `The run stopped: ${(report?.problems ?? []).join(" ") || "see the report"}`,
      recent_events: recent,
      report: result.report,
      summary_markdown: summary,
    };
  }
  if (running) return { run_id: runId, state: "running", stage, message: `Building. Last stage reached: ${stage}. Check again in a few minutes.`, recent_events: recent, report: null, summary_markdown: null };
  const locked = events.some((e) => e.event === "prd_locked");
  if (request !== null && !locked) {
    return { run_id: runId, state: "awaiting_confirmation", stage: "plan", message: "A plan exists but has not been locked. Show it to the person; call osa_build only on their explicit yes.", recent_events: recent, report: null, summary_markdown: null };
  }
  if (events.length === 0) return { refusal: `Run ${runId} has no events in ${input.repo_dir}.` };
  return {
    run_id: runId,
    state: "interrupted",
    stage,
    message: "The run stopped without recording a result (the MCP server was probably restarted, or the process was killed). Its files up to the last stage are under runs/ and .osa/runs/; start again with osa_plan.",
    recent_events: recent,
    report: null,
    summary_markdown: null,
  };
}

// ---- registration ----------------------------------------------------------------------------------------------------------------

/** Registers osa_plan, osa_build and osa_status. */
export function registerOsaTools(server: McpServer, deps: OsaToolDeps = {}): void {
  server.registerTool("osa_plan", { description: PLAN_TOOL_DESCRIPTION, inputSchema: PlanInput, outputSchema: PlanOutput }, async (input) => {
    try {
      return ok(await planOsaRun(input, deps));
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
  server.registerTool("osa_status", { description: STATUS_TOOL_DESCRIPTION, inputSchema: StatusInput, outputSchema: StatusOutput }, async (input) => {
    try {
      const r = await osaRunStatus(input);
      return "refusal" in r ? refuse(r.refusal) : ok(r);
    } catch (err) {
      return errorResult(err);
    }
  });
}
