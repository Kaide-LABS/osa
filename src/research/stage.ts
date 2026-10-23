// The research stage of the spec phase (WS3): outline + fields from the locked PRD -> tool-driven academic
// and prior-art lookups -> one web-search agent per item (batched, resumable, validated) -> mandatory
// documentation check -> compiled report -> cross-provider check. Runs unattended after the lock.

import { mkdir, writeFile } from "node:fs/promises";
import { StageError } from "../domain/errors.ts";
import type { BabyPrd } from "../domain/intake.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { Outline } from "../domain/research.ts";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import type { EventSink } from "../osa/events.ts";
import { commitPaths } from "../verify/git.ts";
import { repoRelToAbs } from "../util/paths.ts";
import { runAcademicSearch } from "./academic.ts";
import type { AcademicResult } from "./academic.ts";
import { runAllItems } from "./agent.ts";
import type { ItemOutcome } from "./agent.ts";
import { appendCrosscheck } from "./report.ts";
import { crossCheckReport } from "./crosscheck.ts";
import type { CrosscheckResult } from "./crosscheck.ts";
import { assertDocsPresent, collectDocs } from "./docs.ts";
import type { DocsReport } from "./docs.ts";
import { runGithubLookup } from "./github-lookup.ts";
import type { PriorArtResult } from "./github-lookup.ts";
import type { HttpDeps, MinIntervalLimiter } from "./net/http.ts";
import { buildFields, buildOutline, writeOutlineFiles } from "./outline.ts";
import { flagsOf, screenUntrusted } from "../osa/untrusted.ts";
import { compileReport } from "./report.ts";
import { chooseResearchProviders } from "./routing.ts";
import { classifyModel } from "../adapters/model-classes.ts";
import { describeIndependence, independenceOf } from "../domain/independence.ts";
import type { Seat } from "../domain/independence.ts";
import type { ResearchRouting } from "./routing.ts";

/** Inputs of {@link runResearchStage}. */
export interface ResearchStageInput {
  readonly repoDir: string;
  readonly runId: string;
  readonly prd: BabyPrd;
  readonly config: OsaConfig;
  readonly textCall: TextCall;
  readonly events: EventSink;
  /** Whether a provider has built-in web search. Default: the adapter registry's declared capability. */
  readonly hasWebSearch?: (p: ProviderId) => boolean;
  readonly http?: HttpDeps;
  readonly arxivLimiter?: MinIntervalLimiter;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowIso?: () => string;
  /** Commit the research artifacts (default true; tests may disable). */
  readonly commit?: boolean;
}

/** What the stage produced. */
export interface ResearchStageResult {
  readonly skipped: boolean;
  readonly researchDirRel: string;
  readonly reportRel: string;
  readonly reportMd: string;
  readonly outline: Outline | null;
  readonly outcomes: readonly ItemOutcome[];
  readonly docs: DocsReport;
  readonly academic: AcademicResult | null;
  readonly priorArt: PriorArtResult | null;
  readonly routing: ResearchRouting | null;
  readonly crosscheck: CrosscheckResult | null;
  readonly warnings: readonly string[];
}

/** A short plain brief of the locked PRD for research prompts. Pure. */
export function briefOf(prd: BabyPrd): string {
  return [
    "TL;DR:",
    ...prd.tldr.map((l) => `- ${l}`),
    "Acceptance criteria:",
    ...prd.acceptanceCriteria.map((c, i) => `${String(i + 1)}. ${c}`),
    ...(prd.constraints.length > 0 ? ["Constraints:", ...prd.constraints.map((c) => `- ${c}`)] : []),
  ].join("\n");
}

function defaultHasWebSearch(p: ProviderId): boolean {
  const a = ADAPTER_REGISTRY[p];
  return isTextCapable(a) && a.textCapabilities.webSearch;
}

function defaultNoFileAccess(p: ProviderId): boolean {
  const a = ADAPTER_REGISTRY[p];
  return isTextCapable(a) && a.textCapabilities.webContainment === "no-file-access";
}

/** Runs the research stage. Throws {@link StageError} for the loud failures the directive names. */
export async function runResearchStage(input: ResearchStageInput): Promise<ResearchStageResult> {
  const { repoDir, runId, prd, config, events } = input;
  const researchDirRel = `runs/${runId}/research`;
  const reportRel = `${researchDirRel}/report.md`;
  const nowIso = input.nowIso ?? ((): string => new Date().toISOString());

  if (!config.research.enabled) {
    await events.emit("research_validated", { skipped: true, reason: "research.enabled is false" });
    return {
      skipped: true,
      researchDirRel,
      reportRel,
      reportMd: "# Research report\n\n_Research was disabled (research.enabled is false); no research was done._\n",
      outline: null,
      outcomes: [],
      docs: { sources: [], covered: [], uncovered: [] },
      academic: null,
      priorArt: null,
      routing: null,
      crosscheck: null,
      warnings: ["Research is disabled: the spec was written without researched documentation sources."],
    };
  }

  const warnings: string[] = [];
  const hasWeb = input.hasWebSearch ?? defaultHasWebSearch;
  const routing = chooseResearchProviders(config.providers.pair, hasWeb, input.hasWebSearch === undefined ? defaultNoFileAccess : () => false, config.providers.seatModels);
  const researcherSeat: Seat = { provider: routing.researcher, model: routing.researcherModel ?? config.providers.modelOverrides?.[routing.researcher] ?? null };
  const reviewerSeat: Seat = { provider: routing.reviewer, model: routing.reviewerModel ?? config.providers.modelOverrides?.[routing.reviewer] ?? null };
  const independence = independenceOf(researcherSeat, reviewerSeat, classifyModel);
  await events.emit("review_independence", { role: "research", author: researcherSeat, reviewer: reviewerSeat, level: independence });
  if (routing.routedAway) await events.emit("research_routed", { to: routing.researcher, reason: routing.reason });

  const researchDir = repoRelToAbs(repoDir, researchDirRel);
  const resultsDir = `${researchDir}/results`;
  await mkdir(resultsDir, { recursive: true });

  // ---- 1. outline + fields: a pure function of the locked PRD ----
  const outline = buildOutline(prd, config);
  const fields = buildFields(outline);
  await writeOutlineFiles(researchDir, outline, fields);

  // ---- 2. tool-driven lookups ----
  let academic: AcademicResult | null = null;
  if (outline.execution.academic.enabled) {
    academic = await runAcademicSearch({
      queries: outline.execution.academic.queries,
      openalexMailto: config.research.openalexMailto,
      semanticScholar: config.research.semanticScholar,
      events,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.http !== undefined ? { http: input.http } : {}),
      ...(input.arxivLimiter !== undefined ? { arxivLimiter: input.arxivLimiter } : {}),
    });
    await writeFile(`${resultsDir}/academic-papers.json`, JSON.stringify(academic, null, 2) + "\n", "utf8");
  }

  const modelOverride = researcherSeat.model;
  let priorArt: PriorArtResult | null = null;
  if (outline.execution.githubLookup.enabled) {
    priorArt = await runGithubLookup({
      queries: outline.execution.githubLookup.queries,
      events,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.http !== undefined ? { http: input.http } : {}),
      summariser: { textCall: input.textCall, provider: routing.researcher, cwd: repoDir, timeoutMs: config.providers.textTimeoutMs, prdBrief: briefOf(prd) },
    });
    await writeFile(`${resultsDir}/prior-art.json`, JSON.stringify(priorArt, null, 2) + "\n", "utf8");
  }

  // ---- 3. one agent per item ----
  const outcomes = await runAllItems({
    textCall: input.textCall,
    researcher: routing.researcher,
    cwd: repoDir,
    timeoutMs: config.providers.textTimeoutMs,
    events,
    resultsDir,
    outline,
    fields,
    prdBrief: briefOf(prd),
    academicLeads: academic?.papers ?? [],
    modelOverride,
  });
  const done = outcomes.filter((o) => o.status === "done").length;
  const resumed = outcomes.filter((o) => o.status === "resumed").length;
  const failed = outcomes.filter((o) => o.status === "failed");
  await events.emit("research_validated", { items: outcomes.length, done, resumed, failed: failed.length, failedSlugs: failed.map((f) => f.slug) });
  if (done + resumed === 0) {
    throw new StageError(`Every research item failed (${failed.map((f) => f.slug).join(", ")}); there is nothing to build a spec from.`, { failed: failed.map((f) => f.slug) });
  }
  for (const f of failed) warnings.push(`Research item "${f.slug}" could not be completed: ${f.problems.join(" ")}`);

  // ---- 4. mandatory documentation ----
  const results = new Map(outcomes.map((o) => [o.slug, o.result] as const));
  const docs = collectDocs(outline, results);
  if (docs.uncovered.length > 0) warnings.push(`No official documentation was found for: ${docs.uncovered.join("; ")}.`);

  // ---- 5. report (written before the check, so artifacts survive a check failure) ----
  let reportMd = compileReport({ outline, outcomes, docs, academic, priorArt, generatedAt: nowIso(), researcher: routing.researcher });
  reportMd = await screenUntrusted({ text: reportMd, kind: "research report", source: "report.md", events, grow: false });
  await writeFile(`${researchDir}/report.md`, reportMd, "utf8");
  await assertDocsPresent(docs, config.research.docsRequired, events);

  // ---- 6. cross-provider check ----
  let crosscheck: CrosscheckResult | null = null;
  if (config.research.crossProviderCheck) {
    crosscheck = await crossCheckReport({
      reportMd,
      researcher: routing.researcher,
      reviewer: routing.reviewer,
      reviewerHasWebSearch: routing.reviewerHasWebSearch,
      planted: flagsOf(events),
      textCall: input.textCall,
      cwd: repoDir,
      timeoutMs: config.providers.textTimeoutMs,
      events,
      modelOverride: reviewerSeat.model,
      independenceNote: describeIndependence(independence, researcherSeat, reviewerSeat),
    });
    if (independence === "same-model" || independence === "unverified") warnings.push(describeIndependence(independence, researcherSeat, reviewerSeat));
    reportMd = appendCrosscheck(reportMd, crosscheck.sectionMd);
    if (crosscheck.degraded) warnings.push(`The research check by ${routing.reviewer} was consistency-only: it has no web access to open the cited sources.`);
    if (crosscheck.flagged.length > 0) warnings.push(`${String(crosscheck.flagged.length)} research claim(s) were not confirmed by the cross-provider check.`);
  } else {
    await events.emit("research_crosscheck", { skipped: true, reason: "research.crossProviderCheck is false" });
    reportMd = appendCrosscheck(reportMd, "## Independent check\n\n_Skipped: research.crossProviderCheck is false in the configuration. This report was NOT independently checked._");
    warnings.push("The cross-provider research check was disabled by configuration; the research report was not independently checked.");
  }
  await writeFile(`${researchDir}/report.md`, reportMd, "utf8");

  if (input.commit !== false) {
    await commitPaths(repoDir, `chore: research artifacts for OSA run ${runId}`, [researchDirRel]);
  }

  return { skipped: false, researchDirRel, reportRel, reportMd, outline, outcomes, docs, academic, priorArt, routing, crosscheck, warnings };
}
