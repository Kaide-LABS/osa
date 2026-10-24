// The `osa "<prompt>"` pipeline. Stages run in a fixed order; the lock is the only human touchpoint:
//
//   intake -> [lock] -> commit locked artifacts -> (spec -> build -> verify -> summarise: later workstreams)
//
// Every collaborator that touches the outside world (model calls, terminal, clock) is injected, so the
// whole pipeline is testable with fakes and no provider CLI.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ExitCode, UsageError } from "../domain/errors.ts";
import type { BabyPrd } from "../domain/intake.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { TextCall } from "../ports/text-provider.ts";
import { makeTextCall } from "../dispatch/text-call.ts";
import { commitPaths, revParse } from "../verify/git.ts";
import { loadOsaConfig } from "../util/config-file.ts";
import { NO_EXPLICIT_KEYS, applyFeatureFlags, describeFeatures } from "../features/features.ts";
import type { FeatureFlags } from "../features/features.ts";
import { repoRelToAbs } from "../util/paths.ts";
import { parseBabyPrd, renderBabyPrd } from "./baby-prd.ts";
import { FileEventSink } from "./events.ts";
import type { EventSink } from "./events.ts";
import { InjectionTracker } from "./untrusted.ts";
import { runProcess } from "../util/exec.ts";
import { TOKEN_CATEGORIES, TokenAccountant, accountedRunProcess, accountedTextCall } from "./tokens.ts";
import { screenHits } from "../code-index/guard.ts";
import { runIntake } from "./intake.ts";
import type { IntakeFile } from "./intake.ts";
import { assertPrdUnchanged, exitCodeForLockOutcome, lockBabyPrd } from "./lock.ts";
import type { LockIO, LockOutcome } from "./lock.ts";
import { makeTerminalLockIO } from "./terminal.ts";
import { runDrive } from "../dispatch/driver-loop.ts";
import type { DriveDispatchDeps, DrivePhaseHooks } from "../dispatch/driver-loop.ts";
import { DriveConfig } from "../domain/driver.ts";
import { trimText } from "../trim/handoff.ts";
import type { HandoffDeps } from "../trim/handoff.ts";
import { resolveTrimmerLazily } from "../trim/resolve.ts";
import type { ResolvedTrimmer } from "../trim/resolve.ts";
import { briefOf, runResearchStage } from "../research/stage.ts";
import { chooseLateralProvider, renderAlternatives, runLateralArchitectureAgent } from "../agents/lateral-architecture.ts";
import { runImplicationAgent } from "../agents/implication.ts";
import { applicationNotes, chooseApplicationProvider, runApplicationAgent, writeApplicationReport } from "../agents/application.ts";
import type { ApplicationVerdict, Sandbox } from "../agents/application.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import type { ProviderId } from "../domain/run.ts";
import type { ResearchStageInput, ResearchStageResult } from "../research/stage.ts";
import { runArchitectureDecision, runSpecStage, specDirRel } from "./spec.ts";
import type { SpecStageResult } from "./spec.ts";
import { executorContextRel, initialExecutorContext, runStep14, step14DirRel } from "./step14.ts";
import { writeRunSummary } from "./summary.ts";
import { plainChoices } from "./plain-choices.ts";
import { caveatFor, createCodeSearcher } from "../code-index/searcher.ts";
import { rewriteSeatFor } from "../code-index/rewrite-seat.ts";
import type { CodeSearchEngine } from "../code-index/engine.ts";
import { writeRunMemory } from "../memory/derive.ts";
import type { PhaseRecord } from "../memory/derive.ts";
import { readMemoryForPrompt } from "../memory/store.ts";
import { renderIndexContext } from "../code-index/search.ts";
import { nextPhaseSpecPath } from "../dispatch/artifacts.ts";
import type { StageNote } from "./summary.ts";
import { applySeatPlan, healthyProviders, liveProbe, modelFor, planSeats, probeProviders, seatKey } from "./seats.ts";
import type { ProviderProbe } from "./seats.ts";
import { describeIndependence } from "../domain/independence.ts";
import type { Seat } from "../domain/independence.ts";
import { runPreflight } from "../verify/preflight.ts";
import type { PreflightSummary } from "../verify/preflight.ts";

/** Flags of `osa "<prompt>"`. */
export interface OsaCommandOptions {
  readonly prompt: string;
  /** `--file`: paths (absolute or relative to `repoDir`) inlined into intake. */
  readonly files: readonly string[];
  readonly repoDir: string;
  /** `--yes`: unattended; auto-lock only with zero risky assumptions. */
  readonly yes: boolean;
  readonly json: boolean;
  /** `false` (`--spec-only`) stops after the spec; default is to build. */
  readonly build?: boolean;
  /** Per-run overrides of the optional plug-ins (`--index-engine`, `--trim` / `--no-trim`, `--quote-stated-rules`); they win over `osa.config.json`. */
  readonly features?: FeatureFlags;
  /**
   * Stop right after intake: the draft plan is written to `runs/<id>/baby-prd.md` and the report says stage "intake", lock "not-reached". Nothing is
   * locked or run. This is the first half of the two-step flow the MCP tools use (`osa_plan`), where the person confirms in their own chat.
   */
  readonly stopAfterPlan?: boolean;
  /**
   * Continue from the draft plan already at `runs/<id>/baby-prd.md` (the run id comes from `deps.runId`) instead of running intake again, so the
   * plan that is locked is exactly the plan the person was shown. The second half of the two-step flow (`osa_build`).
   */
  readonly fromDraft?: boolean;
}

/** Collaborators; every field defaults to the real thing. */
export interface OsaDeps {
  /** Test seam: which providers are usable (default: a real preflight of every provider). Only consulted when the config file sets no `providers.pair`. */
  readonly preflightFn?: () => Promise<Pick<PreflightSummary, "providers">>;
  /**
   * Test seam: asks one provider a tiny question; null = it answered. When OSA chooses the providers itself it probes each candidate first (a provider can
   * be installed and signed in yet fail every call). Default: a real call; skipped when a fake `textCall` is injected and no probe is.
   */
  readonly probeProvider?: ProviderProbe;
  readonly textCall?: TextCall;
  readonly io?: LockIO;
  readonly events?: EventSink;
  /** Whether a human can answer the lock prompt. Default: both stdin and stdout are TTYs. */
  readonly interactive?: boolean;
  readonly runId?: string;
  /** Project memory block for intake (WS8). */
  readonly readMemory?: (repoDir: string) => Promise<string | null>;
  /** Config override (tests); default: loaded from `osa.config.json`. */
  readonly config?: OsaConfig;
  /** Test seams for the research stage (fake HTTP, limiter, environment, capability table). */
  readonly research?: Partial<Pick<ResearchStageInput, "http" | "arxivLimiter" | "env" | "hasWebSearch" | "nowIso">>;
  /** Trimmer override (tests); default: resolved from `trim` config (trim-1 if installed, else no-op). */
  readonly trimmer?: ResolvedTrimmer;
  /** Test seams for the build driver (fake dispatch, adapters, preflight). */
  readonly drive?: Omit<DriveDispatchDeps, "hooks">;
  /** Whether a provider can run commands in a text call (default: the adapter registry's declared capability). */
  readonly canExecute?: (p: ProviderId) => boolean;
  /** Test seam: replaces the git-clone sandbox of the application check. */
  readonly sandboxFactory?: (repoDir: string) => Promise<Sandbox>;
  /** Test seam: replaces opening the codebase-memory-mcp engine (only ever called when `index.engine` is "cbm"). */
  readonly openCbm?: () => Promise<CodeSearchEngine>;
  /** Test seam: the process runner trim-1 is probed and run with (only ever called when `trim.enabled` is true). */
  readonly trimSpawn?: typeof runProcess;
}

/** Shown to the person when the locked PRD changed mid-build; the raw message (path, hashes) goes under "For engineers" via the run's problems. */
const PRD_CHANGED_PLAIN = "The locked PRD file changed after it was locked, so the build was stopped to protect what you approved.";

function defaultCanExecute(p: ProviderId): boolean {
  const a = ADAPTER_REGISTRY[p];
  return isTextCapable(a) && a.textCapabilities.execute;
}

/** How far the pipeline got. */
export type OsaStage = "intake" | "lock" | "research" | "spec" | "build" | "verify" | "done";

/** The result of {@link runOsaCommand}. */
export interface OsaRunReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly run_id: string;
  readonly ok: boolean;
  readonly exit_code: number;
  readonly stage: OsaStage;
  readonly lock: "locked" | "cancelled" | "refused" | "not-reached";
  readonly prd_path: string | null;
  readonly prd_sha256: string | null;
  readonly assumptions: { readonly risky: number; readonly safe: number };
  /** Research summary, `null` until the research stage has run. */
  readonly research: { readonly skipped: boolean; readonly items: number; readonly docSources: number; readonly papers: number; readonly repos: number; readonly crossChecked: boolean } | null;
  /** Spec artifacts, `null` until the spec stage has run. */
  readonly spec: { readonly spec_path: string; readonly context_path: string; readonly total_phases: number; readonly assumptions: number } | null;
  /** Build summary, `null` until the build stage has run (or when `--spec-only`). */
  readonly build: { readonly ok: boolean; readonly exit_code: number; readonly phases_run: number; readonly final_state: string } | null;
  /** What the agents between spec and build, and the application check, did; `null` until they have run. */
  readonly agents: {
    readonly architecture: { readonly chosen: string; readonly why: string; readonly provider: string } | null;
    readonly implications: { readonly acceptanceAdded: number; readonly outOfScopeAdded: number } | null;
    readonly application: { readonly passed: boolean; readonly met: number; readonly unmet: number; readonly could_not_run: string | null } | null;
  } | null;
  /** Who wrote and who reviewed, and how independent the review was (the person can act on a weak one). */
  readonly review?: { readonly author: string; readonly reviewer: string; readonly level: string; readonly text: string };
  /** Repo-relative path of the plain-language run summary, or `null`. */
  readonly summary_path: string | null;
  readonly warnings: readonly string[];
  readonly problems: readonly string[];
}

/** Repo-relative directory holding one run's tracked artifacts. */
export function runDirRel(runId: string): string {
  return `runs/${runId}`;
}

/** Repo-relative path of the baby PRD for `runId`. */
export function babyPrdRelPath(runId: string): string {
  return `${runDirRel(runId)}/baby-prd.md`;
}

async function readAttachments(repoDir: string, files: readonly string[]): Promise<IntakeFile[]> {
  const out: IntakeFile[] = [];
  for (const f of files) {
    const abs = /^([a-zA-Z]:[\\/]|\/)/.test(f) ? f : `${repoDir}/${f}`;
    try {
      out.push({ path: f, content: await readFile(abs, "utf8") });
    } catch (err) {
      throw new UsageError(`Cannot read --file "${f}": ${err instanceof Error ? err.message : String(err)}`, { file: f });
    }
  }
  return out;
}

function counts(prd: BabyPrd): { risky: number; safe: number } {
  const risky = prd.assumptions.filter((a) => a.risk === "risky").length;
  return { risky, safe: prd.assumptions.length - risky };
}

function lockLabel(outcome: LockOutcome): OsaRunReport["lock"] {
  return outcome.kind;
}

/**
 * Runs intake and the lock (and, in later workstreams, everything after). Returns a report; a modelled
 * stop (cancel, refused auto-lock) is a normal return with a non-zero `exit_code`, while a broken
 * invariant (provider failure at intake, PRD tampering) throws a `OsaError`.
 */
export async function runOsaCommand(opts: OsaCommandOptions, deps: OsaDeps = {}): Promise<OsaRunReport> {
  const runId = deps.runId ?? randomUUID();
  const loaded = deps.config === undefined ? await loadOsaConfig(opts.repoDir) : { config: deps.config, source: null, warnings: [] as string[], explicit: NO_EXPLICIT_KEYS, pairSet: true };
  // The optional plug-ins (CBM, trim-1, quoted stated rules): config < flag. Each is off unless switched on; nothing of an off feature runs.
  const baseConfig = applyFeatureFlags(loaded.config, opts.features ?? {});
  const featureStates = describeFeatures(baseConfig, loaded.explicit, opts.features ?? {});
  // Who sits where (src/osa/seats.ts): the providers are chosen from what is installed unless the config names a pair, and two seats on
  // one provider get different models. Nothing here refuses a configuration.
  let healthy = loaded.pairSet ? [] : healthyProviders(await (deps.preflightFn ?? (() => runPreflight(opts.repoDir)))());
  let skipped: { provider: ProviderId; reason: string }[] = [];
  if (!loaded.pairSet && healthy.length > 0) {
    const probe = deps.probeProvider ?? (deps.textCall === undefined ? liveProbe({ cwd: opts.repoDir, ...(baseConfig.providers.modelOverrides !== undefined ? { modelOverrides: baseConfig.providers.modelOverrides } : {}) }) : null);
    if (probe !== null) {
      const probed = await probeProviders(healthy, probe);
      healthy = probed.live;
      skipped = probed.skipped;
    }
  }
  const seatPlan = planSeats({ config: baseConfig, pairSet: loaded.pairSet, healthy, skipped });
  const config = applySeatPlan(baseConfig, seatPlan);
  const seatCandidates = seatPlan.candidates;
  // Every stage logs through a tracker so planted-instruction evidence (`injection_flagged`) reaches the cross-check and the summary.
  const events: EventSink = new InjectionTracker(deps.events ?? new FileEventSink(opts.repoDir, runId));
  const warnings: string[] = [...loaded.warnings];
  const interactive = deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (!opts.yes && !interactive) {
    throw new UsageError(
      "osa needs an interactive terminal to confirm the lock. Re-run in a terminal, or pass --yes for an " +
        "unattended run (it locks automatically only when there are no risky assumptions).",
    );
  }
  try {
    await revParse(opts.repoDir, "HEAD");
  } catch {
    throw new UsageError(
      `"${opts.repoDir}" is not a git repository with at least one commit. osa builds inside git (it verifies every ` +
        "phase through git history): run `git init` and make an initial commit, then try again.",
      { repoDir: opts.repoDir },
    );
  }

  await events.emit("run_started", { prompt_chars: opts.prompt.length, files: opts.files.length, unattended: opts.yes });
  await events.emit("config_loaded", { source: loaded.source, warnings: loaded.warnings });
  await events.emit("seats_resolved", { pair: seatPlan.pair, seatModels: seatPlan.seatModels, auto: seatPlan.auto, notes: seatPlan.notes });
  await events.emit("review_independence", { role: "build", author: seatPlan.review.author, reviewer: seatPlan.review.reviewer, level: seatPlan.review.level });
  const reviewText = describeIndependence(seatPlan.review.level, seatPlan.review.author, seatPlan.review.reviewer);
  if (seatPlan.review.level === "same-model" || seatPlan.review.level === "unverified" || seatPlan.auto) warnings.push(...seatPlan.notes);
  for (const f of featureStates) await events.emit("feature_state", { feature: f.id, state: f.enabled ? "enabled" : "disabled", value: f.value, source: f.source });

  // Token accounting (Suite 7a): every text exchange and every provider process is recorded by category, per phase and per run.
  const acct = new TokenAccountant();
  const rawTextCall = deps.textCall ?? makeTextCall({ events, runProcessFn: accountedRunProcess(runProcess, acct), ...(config.providers.modelOverrides !== undefined ? { modelOverrides: config.providers.modelOverrides } : {}) });
  const textCall = accountedTextCall(rawTextCall, acct);
  const files = await readAttachments(opts.repoDir, opts.files);
  // Project memory (WS8): read at intake so assumptions follow what this project has already decided.
  const readMemory = deps.readMemory ?? ((dir: string) => readMemoryForPrompt(dir, config.memory.readBudgetChars));
  const memory = config.memory.enabled ? await readMemory(opts.repoDir) : null;

  // ---- intake (or, when continuing a confirmed plan, the draft the person was shown) ----
  const prdPath = babyPrdRelPath(runId);
  const prdAbs = repoRelToAbs(opts.repoDir, prdPath);
  let prd: BabyPrd;
  if (opts.fromDraft === true) {
    prd = parseBabyPrd(await readFile(prdAbs, "utf8"));
  } else {
    ({ prd } = await runIntake(
      { prompt: opts.prompt, files, memory, maxItems: config.research.maxItems, quoteStatedRules: config.intake.quoteStatedRules },
      { textCall, provider: config.providers.pair[0], model: modelFor(config, config.providers.pair[0], 0), cwd: opts.repoDir, timeoutMs: config.providers.textTimeoutMs, events },
    ));
    await mkdir(dirname(prdAbs), { recursive: true });
    await writeFile(prdAbs, renderBabyPrd(prd), "utf8");
  }
  if (opts.stopAfterPlan === true) {
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      ok: true,
      exit_code: ExitCode.OK,
      stage: "intake",
      lock: "not-reached",
      prd_path: prdPath,
      prd_sha256: null,
      assumptions: counts(prd),
      research: null,
      spec: null,
      build: null,
      agents: null,
      review: { author: seatKey(seatPlan.review.author), reviewer: seatKey(seatPlan.review.reviewer), level: seatPlan.review.level, text: reviewText },
      summary_path: null,
      warnings,
      problems: [],
    };
  }

  // ---- lock ----
  const outcome = await lockBabyPrd({
    repoDir: opts.repoDir,
    runId,
    prdPath,
    io: deps.io ?? makeTerminalLockIO(opts.repoDir),
    events,
    unattended: opts.yes,
    autoLockWhenNoRisky: config.intake.autoLockWhenNoRisky,
  });

  if (outcome.kind !== "locked") {
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      ok: false,
      exit_code: exitCodeForLockOutcome(outcome),
      stage: "lock",
      lock: lockLabel(outcome),
      prd_path: prdPath,
      prd_sha256: null,
      assumptions: counts(prd),
      research: null,
      spec: null,
      build: null,
      agents: null,
      summary_path: null,
      warnings,
      problems: outcome.kind === "refused" ? [outcome.message] : ["Cancelled at the lock; nothing was run."],
    };
  }

  // Pin the locked hash in THIS process's memory. The on-disk lock record sits in the repository beside the PRD, so an agent that
  // rewrites the PRD could rewrite the record to match; only this copy is out of its reach (Suite 4).
  const pinned = { sha256: outcome.record.sha256, prd_path: outcome.record.prd_path };

  // The harness hashes artifacts_read at head_before, so the locked PRD must be committed before dispatch.
  await commitPaths(opts.repoDir, `chore: lock baby PRD for OSA run ${runId}`, [prdPath]);

  // ---- trimming engine, resolved once: used for every handoff from here on ----
  const resolved = deps.trimmer ?? (await resolveTrimmerLazily(config.trim, { cwd: opts.repoDir, ...(deps.trimSpawn !== undefined ? { runProcessFn: deps.trimSpawn } : {}) }));
  const trimDeps: HandoffDeps = { trimmer: resolved.trimmer, events, defaultBudgetTokens: config.trim.budgetTokens, engineNote: resolved.note };

  // ---- research (unattended from here on; the locked PRD is re-verified between every stage) ----
  await assertPrdUnchanged(opts.repoDir, runId, "before research", events, pinned);
  const research: ResearchStageResult = await runResearchStage({
    repoDir: opts.repoDir,
    runId,
    prd: outcome.prd,
    config,
    textCall,
    events,
    ...(deps.research ?? {}),
  });
  warnings.push(...research.warnings);
  await assertPrdUnchanged(opts.repoDir, runId, "after research", events, pinned);

  // ---- spec (research output -> spec input is a trimmed handoff; the PRD itself is passed verbatim) ----
  const prdMarkdown = await readFile(prdAbs, "utf8");
  const reportForSpec = await trimText("research-report", research.reportMd, briefOf(outcome.prd), trimDeps);
  const spec: SpecStageResult = await runSpecStage({
    repoDir: opts.repoDir,
    runId,
    prdMarkdown,
    reportMarkdown: reportForSpec,
    docs: research.docs,
    flaggedClaims: (research.crosscheck?.flagged ?? []).map((c) => c.claim),
    ...(memory !== null ? { extraSections: [{ title: "Project memory (earlier runs on this project)", body: memory }] } : {}),
    config,
    textCall,
    events,
  });
  let architecture: { chosen: string; why: string; provider: string } | null = null;
  let implications: { acceptanceAdded: number; outOfScopeAdded: number } | null = null;
  // ---- agents between spec and build (each config-gated; a failure of an ADVISORY agent is warned, never silent) ----
  const specAbs = repoRelToAbs(opts.repoDir, spec.specPath);
  const contextAbs = repoRelToAbs(opts.repoDir, spec.contextPath);
  const agentTimeout = config.providers.textTimeoutMs;
  const planner = config.providers.pair[0];
  const plannerSeat: Seat = { provider: planner, model: modelFor(config, planner, 0) };

  if (config.agents.lateralArchitecture) {
    const choice = chooseLateralProvider(config.agents, plannerSeat, seatCandidates);
    if (choice.warning !== null) warnings.push(choice.warning);
    const lateral = await runLateralArchitectureAgent({
      prdMarkdown,
      contextMarkdown: await readFile(contextAbs, "utf8"),
      researchDigest: reportForSpec,
      choice,
      textCall,
      events,
      cwd: opts.repoDir,
      timeoutMs: agentTimeout,
      modelOverride: choice.model ?? config.providers.modelOverrides?.[choice.provider] ?? null,
    });
    if (lateral.report !== null) {
      const decision = await runArchitectureDecision({
        repoDir: opts.repoDir,
        runId,
        prdMarkdown,
        contextMarkdown: await readFile(contextAbs, "utf8"),
        specMarkdown: await readFile(specAbs, "utf8"),
        alternativesText: renderAlternatives(lateral.report),
        alternativeNames: lateral.report.alternatives.map((a) => a.name),
        docs: research.docs,
        config,
        textCall,
        events,
        specPath: spec.specPath,
        contextPath: spec.contextPath,
      });
      architecture = { chosen: decision.chosen, why: decision.why, provider: seatKey({ provider: choice.provider, model: choice.model }) };
    } else {
      warnings.push(`The independent architecture review (${choice.provider}) could not be completed (${lateral.failure ?? "unknown reason"}); ${planner}'s plan was not challenged.`);
    }
  }

  if (config.agents.implication) {
    const provider = config.agents.implicationProvider ?? config.providers.pair[1];
    const implication = await runImplicationAgent({
      prdMarkdown,
      contextMarkdown: await readFile(contextAbs, "utf8"),
      specMarkdown: await readFile(specAbs, "utf8"),
      provider,
      textCall,
      events,
      cwd: opts.repoDir,
      timeoutMs: agentTimeout,
      modelOverride: modelFor(config, provider, 1),
    });
    if (implication.ok) {
      await writeFile(specAbs, implication.specMarkdown, "utf8");
      implications = { acceptanceAdded: implication.acceptanceAdded, outOfScopeAdded: implication.outOfScopeAdded };
    } else {
      warnings.push(`The implication review (${provider}) could not be completed (${implication.failure ?? "unknown reason"}); the spec was built without it.`);
    }
  }

  await commitPaths(opts.repoDir, `chore: spec for OSA run ${runId}`, [specDirRel(runId)]);
  await assertPrdUnchanged(opts.repoDir, runId, "after spec", events, pinned);

  const researchSummary: NonNullable<OsaRunReport["research"]> = {
    skipped: research.skipped,
    items: research.outcomes.length,
    docSources: research.docs.sources.length,
    papers: research.academic?.papers.length ?? 0,
    repos: research.priorArt?.repos.length ?? 0,
    crossChecked: research.crosscheck !== null,
  };
  const specSummary: NonNullable<OsaRunReport["spec"]> = {
    spec_path: spec.specPath,
    context_path: spec.contextPath,
    total_phases: spec.totalPhases,
    assumptions: spec.specAssumptions.length,
  };
  const base = {
    review: { author: seatKey(seatPlan.review.author), reviewer: seatKey(seatPlan.review.reviewer), level: seatPlan.review.level, text: reviewText },
    schema_version: 1 as const,
    run_id: runId,
    lock: "locked" as const,
    prd_path: prdPath,
    prd_sha256: outcome.record.sha256,
    assumptions: counts(outcome.prd),
    research: researchSummary,
    spec: specSummary,
  };

  // ---- project memory: written from the run's record (never mid-run chatter) at EVERY run end ----
  const phaseRecords: PhaseRecord[] = [];
  const recordMemory = async (end: { outcome: "finished" | "stopped"; stoppedBecause: string | null; application: ApplicationVerdict | null }): Promise<void> => {
    if (!config.memory.enabled) return;
    try {
      await writeRunMemory(
        opts.repoDir,
        {
          runId,
          date: new Date().toISOString().slice(0, 10),
          prdGenerated: prd,
          prdLocked: outcome.prd,
          outcome: end.outcome,
          stoppedBecause: end.stoppedBecause,
          specAssumptions: spec.specAssumptions,
          architecture: architecture !== null ? { chosen: architecture.chosen, why: architecture.why } : null,
          flaggedClaims: (research.crosscheck?.flagged ?? []).map((c) => c.claim),
          failedResearchItems: research.outcomes.filter((o) => o.status === "failed").map((o) => ({ slug: o.slug, problem: o.problems[0] ?? "unknown" })),
          phases: phaseRecords,
          applicationUnmet: end.application?.unmet.map((u) => ({ text: u.text, reason: u.reason })) ?? [],
          applicationCouldNotRun: end.application?.couldNotRun ?? null,
        },
        { maxFacts: config.memory.maxFactsPerFile, events },
      );
    } catch (err) {
      warnings.push(`Project memory could not be written (${err instanceof Error ? err.message : String(err)}); the run itself is unaffected.`);
    }
  };

  if (opts.build === false) {
    await recordMemory({ outcome: "finished", stoppedBecause: null, application: null });
    return { ...base, generated_at: new Date().toISOString(), ok: true, exit_code: ExitCode.OK, stage: "spec", build: null, agents: { architecture, implications, application: null }, summary_path: null, warnings, problems: [] };
  }

  // ---- build: the existing cross-provider driver, with PRD-integrity and step-14 hooks around every phase ----
  const stageNotes: StageNote[] = [];
  const oneLiners: string[] = [];
  const ctxRel = executorContextRel(runId);
  await mkdir(repoRelToAbs(opts.repoDir, step14DirRel(runId)), { recursive: true });
  // The semantic code index (WS7): refresh it and hand the build agents a ranked "where to look first" list.
  const searcher = createCodeSearcher({ repoDir: opts.repoDir, index: config.index, events, rewriteSeat: rewriteSeatFor(config), textCall, ...(deps.openCbm !== undefined ? { openCbm: deps.openCbm } : {}) });
  const indexContextFor = async (queryText: string): Promise<string> => {
    if (!config.index.enabled) return "";
    try {
      const answer = await searcher.search(queryText.slice(0, 1500), { k: config.index.topK, purpose: "agent-context" });
      const hits = answer.hits;
      const screened = screenHits(hits);
      if (screened.flags.length > 0) {
        await events.emit("injection_flagged", {
          kind: "code snippet",
          source: "code index (auto-inserted agent context)",
          removedLines: screened.flags.length,
          hiddenItems: 0,
          scrubbed: [],
          rules: [...new Set(screened.flags.map((f) => f.rule))],
          flags: screened.flags.slice(0, 5),
        });
      }
      return renderIndexContext(hits, 4, caveatFor(answer));
    } catch (err) {
      warnings.push(`The code index could not be updated (${err instanceof Error ? err.message : String(err)}); agents fall back to grep.`);
      return "";
    }
  };
  try {
    const firstQuery = `${outcome.prd.tldr.join(" ")} ${await readFile(specAbs, "utf8")}`;
    await writeFile(repoRelToAbs(opts.repoDir, ctxRel), initialExecutorContext(await indexContextFor(firstQuery)), "utf8");
    await commitPaths(opts.repoDir, `chore: initial phase context for OSA run ${runId}`, [step14DirRel(runId)]);
  } catch (err) {
    await searcher.close();
    throw err;
  }

  const driveConfig = DriveConfig.parse({
    repo_dir: opts.repoDir,
    driver_run_id: randomUUID(),
    starting_phase: 1,
    starting_spec_path: spec.specPath,
    baby_prd_path: prdPath,
    context_path: spec.contextPath,
    target_total_phases: spec.totalPhases,
    executor_providers: config.providers.pair,
    seat_models: config.providers.seatModels,
    turn_timeout_ms: config.providers.turnTimeoutMs,
    executor_prompt_path: ctxRel,
    reviewer_prompt_path: ctxRel,
    ...(config.providers.rolePins !== undefined ? { role_pins: config.providers.rolePins } : {}),
    ...(config.providers.modelOverrides !== undefined ? { model_overrides: config.providers.modelOverrides } : {}),
  });

  const hooks: DrivePhaseHooks = {
    beforePhase: async (ctx) => {
      acct.setPhase(ctx.phase);
      await assertPrdUnchanged(opts.repoDir, runId, `before phase ${String(ctx.phase)}`, events, pinned);
    },
    afterPhase: async (ctx, result) => {
      // A tampered PRD is a hard failure -- but step 14 still reports the phase first, so the person is told.
      let violation: unknown = null;
      try {
        await assertPrdUnchanged(opts.repoDir, runId, `after phase ${String(ctx.phase)}`, events, pinned);
      } catch (err) {
        violation = err;
      }
      let nextSpecText = "";
      try {
        nextSpecText = await readFile(repoRelToAbs(opts.repoDir, nextPhaseSpecPath(ctx.specPath, ctx.phase, false)), "utf8");
      } catch {
        // final phase, or the reviewer wrote no next spec: query by the PRD alone
      }
      const indexContext = await indexContextFor(`${outcome.prd.tldr.join(" ")} ${nextSpecText}`);
      const s14 = await runStep14({
        indexContext,
        repoDir: opts.repoDir,
        runId,
        phaseRunId: ctx.runConfig.run_id,
        phase: ctx.phase,
        isFinalPhase: ctx.isFinalPhase,
        result,
        prd: outcome.prd,
        config,
        textCall,
        events,
        trim: trimDeps,
        earlier: oneLiners,
        ...(violation !== null ? { extraProblems: [PRD_CHANGED_PLAIN] } : {}),
      });
      stageNotes.push({ phase: ctx.phase, ok: result.ok, summary: s14.summary });
      phaseRecords.push({ phase: ctx.phase, ok: result.ok, retriedTurns: result.turns.filter((t) => t.retried).length, problems: [...result.problems] });
      oneLiners.push(`phase ${String(ctx.phase)}: ${firstBullet(s14.summary)}`);
      await acct.emit(events, ctx.phase);
      acct.setPhase(null);
      if (violation !== null) throw violation;
    },
  };

  let driven: Awaited<ReturnType<typeof runDrive>>;
  try {
    driven = await runDrive(driveConfig, { ...(deps.drive ?? {}), runProcessFn: accountedRunProcess(deps.drive?.runProcessFn ?? runProcess, acct), hooks });
  } finally {
    // The semantic index (when index.engine is "cbm") holds a child process; it never outlives the build.
    await searcher.close();
  }
  warnings.push(...driven.warnings);

  // ---- application check: only a build that finished can be exercised; unmet criteria FAIL the run ----
  let application: ApplicationVerdict | null = null;
  if (driven.ok && config.agents.application) {
    const canExecute = deps.canExecute ?? defaultCanExecute;
    const provider = chooseApplicationProvider(config.agents, config.providers.pair, canExecute);
    application = await runApplicationAgent({
      repoDir: opts.repoDir,
      prd: outcome.prd,
      specMarkdown: await readFile(specAbs, "utf8"),
      prdPath,
      specPath: spec.specPath,
      contextPath: spec.contextPath,
      provider,
      textCall,
      events,
      timeoutMs: agentTimeout,
      modelOverride: modelFor(config, provider, 1),
      ...(deps.sandboxFactory !== undefined ? { sandboxFactory: deps.sandboxFactory } : {}),
    });
    const appDir = await writeApplicationReport(opts.repoDir, runId, application);
    await commitPaths(opts.repoDir, `chore: application check for OSA run ${runId}`, [appDir]);
  } else if (driven.ok) {
    warnings.push("The application check is switched off (agents.application is false): nobody ran the finished project against the acceptance criteria.");
  }
  const applicationFailed = application !== null && !application.passed;

  // The spec's decisions are engineering text: rewrite the ones that matter to the person in plain words, and keep the raw
  // list for the summary's "For engineers" section only.
  const rawDecisions = [
    ...spec.specAssumptions,
    ...(architecture !== null ? [`Architecture: ${architecture.chosen === "planned" ? "kept the original plan" : `switched to "${architecture.chosen}"`} after an independent review -- ${architecture.why}`] : []),
  ];
  const plain = await plainChoices({
    decisions: rawDecisions,
    textCall,
    provider: planner,
    cwd: opts.repoDir,
    timeoutMs: agentTimeout,
    modelOverride: modelFor(config, planner, 0),
  });

  await acct.emit(events, null);
  const tb = acct.breakdown(null);
  const summaryPath = await writeRunSummary(opts.repoDir, runId, {
    prd: outcome.prd,
    outcome: driven.ok && !applicationFailed ? "finished" : "stopped",
    stoppedBecause: !driven.ok ? plainStop(driven.problems, driven.exitCode) : applicationFailed ? "The finished project did not pass the final check against the requirements." : null,
    stages: stageNotes,
    lockedRiskyAssumptions: outcome.prd.assumptions.filter((a) => a.risk === "risky").map((a) => a.text),
    specDecisions: plain.rewritten ? plain.bullets : [`${String(rawDecisions.length)} technical decision(s) were made while writing the spec; they are listed under "For engineers" at the end.`],
    research: { ...researchSummary, degradedCheck: research.crosscheck?.degraded ?? false },
    warnings,
    technicalDetail: [...driven.problems, ...rawDecisions.map((d) => `decision: ${d}`), `tokens (estimated): ${String(tb.total)} total -- ${TOKEN_CATEGORIES.map((c) => `${c} ${String(Math.round(tb.shares[c] * 100))}%`).join(", ")}`],
    ...(application !== null ? { applicationNotes: applicationNotes(application) } : {}),
  });
  await commitPaths(opts.repoDir, `chore: run summary for OSA run ${runId}`, [summaryPath]);
  await assertPrdUnchanged(opts.repoDir, runId, "end of run", events, pinned);

  await recordMemory({
    outcome: driven.ok && !applicationFailed ? "finished" : "stopped",
    stoppedBecause: !driven.ok ? plainStop(driven.problems, driven.exitCode) : applicationFailed ? "The finished project did not pass the final check." : null,
    application,
  });

  const exitCode = !driven.ok ? driven.exitCode : applicationFailed ? ExitCode.APPLICATION_CHECK_FAILED : ExitCode.OK;
  return {
    ...base,
    generated_at: new Date().toISOString(),
    ok: driven.ok && !applicationFailed,
    exit_code: exitCode,
    stage: !driven.ok ? "build" : applicationFailed ? "verify" : "done",
    build: { ok: driven.ok, exit_code: driven.exitCode, phases_run: new Set(driven.phases.map((p) => p.dispatched_run_id).filter((id): id is string => id !== null)).size, final_state: driven.finalStateId },
    agents: {
      architecture,
      implications,
      application:
        application === null
          ? null
          : { passed: application.passed, met: application.results.filter((r) => r.status === "met").length, unmet: application.unmet.length, could_not_run: application.couldNotRun },
    },
    summary_path: summaryPath,
    warnings,
    problems: !driven.ok ? driven.problems : applicationFailed ? applicationNotes(application as ApplicationVerdict) : [],
  };
}

/** First bullet of a summary's "What was built" section, trimmed, for one-line phase recaps. Pure. */
export function firstBullet(summary: string): string {
  const m = summary.match(/^##\s+What was built\s*\r?\n+\s*(?:[-*]\s*)?(.+)$/m);
  return (m?.[1] ?? "see the stage summary").trim().slice(0, 200);
}

/**
 * A plain-language reason for a stopped build, chosen by what KIND of failure it was (the exit code), never by pasting
 * the raw error: paths, JSON fragments and stack text belong in the summary's "For engineers" section. Pure.
 */
export function plainStop(_problems: readonly string[], exitCode: number): string {
  switch (exitCode) {
    case ExitCode.PREFLIGHT_FAILED:
      return "One of the AI tools needed for the build was not ready (missing, out of date, or not signed in), so nothing could be built.";
    case ExitCode.RELAY_SCHEMA_INVALID:
      return "One AI tool's hand-over note to the next could not be read, so the build was stopped rather than carry on from a possibly wrong state.";
    case ExitCode.ISOLATION_LEAK:
      return "One AI tool passed along its private reasoning instead of just its results, which the build forbids, so it was stopped.";
    case ExitCode.CONTINUITY_FAILED:
      return "The second AI tool could not confirm that the first one's work had been carried on correctly, even after a second try.";
    case ExitCode.BOUNDARY_VIOLATION:
      return "A change broke one of the project's hard safety rules, so the build was stopped.";
    case ExitCode.LOCK_HELD:
      return "Another build was already running in this folder.";
    case ExitCode.TURN_TIMEOUT:
      return "An AI tool took too long on a step and was stopped.";
    case ExitCode.RUN_HALTED:
      return "One of the AI tools stopped the build on purpose and said it should not continue.";
    case ExitCode.LOOPR_ARTIFACT_BYPASSED:
      return "An AI tool did not actually read the plan it was given, or did not produce the next plan, so the stage was rejected.";
    case ExitCode.DRIVER_HALTED_AMBIGUOUS:
    case ExitCode.DRIVER_HALTED_INCOHERENT:
      return "After a stage finished, the project folder was in a state the build could not interpret, so it stopped instead of guessing.";
    case ExitCode.DRIVER_HALTED_MAX_PHASES:
      return "The build used up its allowed number of stages without finishing.";
    case ExitCode.DRIVER_START_INCOHERENT:
      return "This folder already looks like a finished build, so a new one was not started on top of it.";
    default:
      return "The build stopped before it was finished.";
  }
}

/** Plain-language rendering of an {@link OsaRunReport}. */
export function renderOsaRunReport(report: OsaRunReport): string {
  const lines: string[] = [];
  const state =
    report.lock === "locked"
      ? "locked"
      : report.lock === "cancelled"
        ? "cancelled at the lock"
        : report.lock === "refused"
          ? "stopped at the lock (risky assumptions need a human)"
          : "not started";
  lines.push(`osa run -- ${report.ok ? "OK" : "STOPPED"} (${state}, run ${report.run_id})`);
  if (report.prd_path !== null) lines.push(`PRD: ${report.prd_path}${report.prd_sha256 !== null ? ` (sha256 ${report.prd_sha256.slice(0, 12)}...)` : ""}`);
  lines.push(`Assumptions: ${String(report.assumptions.risky)} risky, ${String(report.assumptions.safe)} safe`);
  if (report.research !== null) {
    const r = report.research;
    lines.push(
      r.skipped
        ? "Research: skipped (disabled in the configuration)"
        : `Research: ${String(r.items)} topic(s) investigated, ${String(r.docSources)} documentation source(s), ${String(r.papers)} academic paper(s), ${String(r.repos)} prior-art repo(s)${r.crossChecked ? ", independently checked by a second AI" : ", NOT independently checked"}`,
    );
  }
  if (report.review !== undefined) lines.push(`Review: ${report.review.text}`);
  if (report.spec !== null) lines.push(`Spec: ${report.spec.spec_path} (${String(report.spec.total_phases)} build phase(s) planned, ${String(report.spec.assumptions)} spec decision(s) logged)`);
  if (report.agents?.architecture != null) {
    const a = report.agents.architecture;
    lines.push(`Architecture: ${a.chosen === "planned" ? "kept the original plan" : `switched to "${a.chosen}"`} after an independent review by ${a.provider}`);
  }
  if (report.agents?.implications != null) {
    const m = report.agents.implications;
    lines.push(`Spec review: ${String(m.acceptanceAdded)} extra requirement(s) and ${String(m.outOfScopeAdded)} out-of-scope line(s) added to the spec`);
  }
  if (report.build !== null) lines.push(`Build: ${report.build.ok ? "finished" : "STOPPED"} after ${String(report.build.phases_run)} phase(s) (${report.build.final_state})`);
  if (report.agents?.application != null) {
    const a = report.agents.application;
    lines.push(a.could_not_run !== null ? `Final check: COULD NOT RUN (${a.could_not_run})` : a.passed ? `Final check: passed (${String(a.met)} requirement(s) seen working)` : `Final check: FAILED (${String(a.unmet)} requirement(s) not met)`);
  }
  if (report.summary_path !== null) lines.push(`Summary for you: ${report.summary_path}`);
  if (report.warnings.length > 0) lines.push("", "Warnings:", ...report.warnings.map((w) => `  - ${w}`));
  if (report.problems.length > 0) lines.push("", "Problems:", ...report.problems.map((p) => `  - ${p}`));
  return lines.join("\n") + "\n";
}
