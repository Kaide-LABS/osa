// The run summary (OSA_DIRECTIVE.md "Plain-language surfaces", WS4.4): a single `runs/<id>/summary.md` written
// for a non-engineer -- what was built, what was decided on their behalf, what is uncertain, and how it was
// checked. Deterministic assembly of pieces that are already plain language (the PRD's TL;DR, each stage's
// layman summary, logged warnings); no model call, so it exists even when everything else went wrong.

import { mkdir, writeFile } from "node:fs/promises";
import type { BabyPrd } from "../domain/intake.ts";
import { repoRelToAbs } from "../util/paths.ts";

/** One stage's plain-language note (from step 14). */
export interface StageNote {
  readonly phase: number;
  readonly ok: boolean;
  readonly summary: string;
}

/** Inputs of {@link renderRunSummary}. */
export interface RunSummaryInput {
  readonly prd: BabyPrd;
  readonly outcome: "finished" | "stopped";
  /** Plain-language reason it stopped (only for `stopped`). */
  readonly stoppedBecause: string | null;
  readonly stages: readonly StageNote[];
  /** Assumptions the person locked (risky first), as written in the PRD. */
  readonly lockedRiskyAssumptions: readonly string[];
  /** Defaulted assumptions (when --yes --accept-risky is used). */
  readonly lockedDefaultedAssumptions?: readonly string[];
  readonly specDecisions: readonly string[];
  readonly research: { readonly skipped: boolean; readonly docSources: number; readonly papers: number; readonly repos: number; readonly crossChecked: boolean; readonly degradedCheck: boolean } | null;
  /** Warnings, already phrased for people. */
  readonly warnings: readonly string[];
  /** Application-check lines (WS6), if any. */
  readonly applicationNotes?: readonly string[];
  /** Raw technical problems (paths, error text). Rendered ONLY in a clearly labelled section at the very end. */
  readonly technicalDetail?: readonly string[];
}

/** Renders the summary. Pure. */
export function renderRunSummary(i: RunSummaryInput): string {
  const L: string[] = [
    `# ${i.outcome === "finished" ? "What OSA built" : "What OSA got done before it stopped"}`,
    "",
    "## In short",
    ...i.prd.tldr.map((l) => `- ${l}`),
  ];
  if (i.outcome === "stopped") {
    L.push("", "## It did not finish", i.stoppedBecause ?? "The run stopped before the project was complete.");
  }
  L.push("", "## Stage by stage");
  if (i.stages.length === 0) L.push("", "_No build stage ran._");
  for (const s of i.stages) {
    L.push("", `### Stage ${String(s.phase)}${s.ok ? "" : " (did not complete)"}`, s.summary.replace(/^## /gm, "#### ").trim());
  }
  L.push("", "## Choices made for you");
  const choices = [
    ...i.lockedRiskyAssumptions.map((a) => `- (you confirmed this risky one) ${a}`),
    ...(i.lockedDefaultedAssumptions ?? []).map((a) => `- (you accepted this as-is) ${a}`),
    ...i.specDecisions.map((d) => `- ${d}`)
  ];
  L.push(...(choices.length === 0 ? ["- None beyond what was in the plan you locked."] : choices));
  if (i.research !== null) {
    L.push("", "## How it was checked");
    const r = i.research;
    L.push(
      r.skipped
        ? "- Research was switched off in the settings, so the plan was not backed by looked-up sources."
        : `- Research: ${String(r.docSources)} official documentation source(s), ${String(r.papers)} academic paper(s) and ${String(r.repos)} existing project(s) were consulted.`,
    );
    if (!r.skipped) {
      L.push(
        r.crossChecked
          ? r.degradedCheck
            ? "- A second AI reviewed the research, but could not open the web sources, so it only checked for consistency."
            : "- A second, different AI checked the research against its sources."
          : "- The research was NOT independently checked (that check was switched off).",
      );
    }
    L.push("- Every build stage was written by one AI and reviewed by a different one, and every change was recorded in git.");
  }
  if (i.applicationNotes !== undefined && i.applicationNotes.length > 0) L.push("", "## Does it actually work?", ...i.applicationNotes.map((n) => `- ${n}`));
  L.push("", "## What to look at", ...(i.warnings.length === 0 ? ["- Nothing was flagged."] : i.warnings.map((w) => `- ${w}`)));
  if (i.technicalDetail !== undefined && i.technicalDetail.length > 0) {
    L.push("", "## For engineers (technical detail)", "", "_Everything above is written for non-engineers; this is the raw detail behind it._", "", ...i.technicalDetail.map((t) => `- \`${t.replace(/`/g, "'").replace(/\s+/g, " ").slice(0, 600)}\``));
  }
  L.push("");
  return L.join("\n");
}

/** Writes `runs/<runId>/summary.md`; returns its repo-relative path. */
export async function writeRunSummary(repoDir: string, runId: string, input: RunSummaryInput): Promise<string> {
  const rel = `runs/${runId}/summary.md`;
  await mkdir(repoRelToAbs(repoDir, `runs/${runId}`), { recursive: true });
  await writeFile(repoRelToAbs(repoDir, rel), renderRunSummary(input), "utf8");
  return rel;
}
