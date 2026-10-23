// Compiles `research/report.md` from the per-item JSONs, the academic-search result and the prior-art result
// (WS3.1 "final report compiled from the JSONs"). Deterministic: no model call. Uncertain values are carried
// through visibly, never smoothed over.

import type { Outline } from "../domain/research.ts";
import type { AcademicResult } from "./academic.ts";
import type { DocsReport } from "./docs.ts";
import { sourcesOf } from "./docs.ts";
import type { ItemOutcome } from "./agent.ts";
import type { PriorArtResult } from "./github-lookup.ts";

function bullets(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string").map((x) => `- ${x}`) : [];
}

/** Inputs of {@link compileReport}. */
export interface ReportInput {
  readonly outline: Outline;
  readonly outcomes: readonly ItemOutcome[];
  readonly docs: DocsReport;
  readonly academic: AcademicResult | null;
  readonly priorArt: PriorArtResult | null;
  /** ISO timestamp the report is stamped with. */
  readonly generatedAt: string;
  /** Provider that researched, for provenance. */
  readonly researcher: string;
}

/** Compiles the report markdown. Pure. */
export function compileReport(input: ReportInput): string {
  const { outline, outcomes, docs, academic, priorArt } = input;
  const bySlug = new Map(outcomes.map((o) => [o.slug, o] as const));
  const lines: string[] = [
    `# Research report -- ${outline.topic}`,
    "",
    `Generated ${input.generatedAt} by OSA. Researched by ${input.researcher} using its built-in web search. Time range: ${outline.execution.timeRange}.`,
    "Values marked [uncertain] could not be verified from a source the agent opened; they are repeated under *Open uncertainties*.",
    "",
    "## Findings",
  ];

  const uncertainRows: string[] = [];
  for (const item of outline.items) {
    const o = bySlug.get(item.slug);
    if (o === undefined || o.result === null) continue;
    const r = o.result;
    lines.push("", `### ${item.title}`, `*${item.question}*`, "", String(r["summary"] ?? ""), "");
    const kf = bullets(r["key_findings"]);
    if (kf.length > 0) lines.push("**Key findings**", ...kf, "");
    const rec = bullets(r["recommendations"]);
    if (rec.length > 0) lines.push("**Recommendations**", ...rec, "");
    for (const extra of ["current_version", "api_surface", "pitfalls"]) {
      const v = r[extra];
      if (typeof v === "string") lines.push(`**${extra.replace(/_/g, " ")}:** ${v}`, "");
      else if (Array.isArray(v)) lines.push(`**${extra.replace(/_/g, " ")}**`, ...bullets(v), "");
    }
    if (typeof r["as_of"] === "string") lines.push(`*As of: ${r["as_of"]}*`, "");
    const srcs = sourcesOf(r);
    if (srcs.length > 0) lines.push("**Sources**", ...srcs.map((s) => `- [${s.title}](${s.url}) (${s.type})${s.quote !== undefined ? ` -- "${s.quote}"` : ""}`), "");
    const unc = Array.isArray(r["uncertain"]) ? (r["uncertain"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    for (const field of unc) uncertainRows.push(`- ${item.title}: \`${field}\``);
  }

  lines.push("## Documentation sources");
  if (docs.sources.length === 0) lines.push("", "_None found._");
  else lines.push("", ...docs.sources.map((d) => `- [${d.title}](${d.url})`));
  if (docs.uncovered.length > 0) lines.push("", `Documentation items with no official source: ${docs.uncovered.join("; ")}.`);

  lines.push("", "## Academic literature");
  if (academic === null) {
    lines.push("", "_Academic search was disabled (research.academic is false)._");
  } else if (academic.papers.length === 0) {
    lines.push("", "_No relevant academic papers were found. This is a valid result, not a failure._");
  } else {
    lines.push("");
    for (const p of academic.papers) {
      lines.push(
        `- **${p.title}**${p.year !== null ? ` (${String(p.year)})` : ""}${p.citedByCount !== null ? `, cited ${String(p.citedByCount)}x` : ""} -- [link](${p.url})${p.pdfUrl !== null ? ` / [PDF](${p.pdfUrl})` : ""} _(via ${p.sources.join(" + ")})_`,
      );
    }
  }
  if (academic !== null && academic.notes.length > 0) lines.push("", ...academic.notes.map((n) => `_${n}_`));

  lines.push("", "## Prior art");
  if (priorArt === null) {
    lines.push("", "_Prior-art lookup was disabled (research.githubLookup is false)._");
  } else if (priorArt.repos.length === 0) {
    lines.push("", "_No public repositories matched._");
  } else {
    lines.push("", ...priorArt.repos.map((r) => `- [${r.fullName}](${r.url}) -- ${String(r.stars)} stars, ${r.language ?? "unknown language"}, licence ${r.license ?? "unknown"}. ${r.description}`));
    if (priorArt.summary !== null) lines.push("", "**Patterns worth reusing**", "", priorArt.summary);
  }
  if (priorArt !== null && priorArt.notes.length > 0) lines.push("", ...priorArt.notes.map((n) => `_${n}_`));

  lines.push("", "## Open uncertainties");
  lines.push("", ...(uncertainRows.length === 0 ? ["_None recorded._"] : uncertainRows));

  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) {
    lines.push("", "## Not researched", "", ...failed.map((o) => `- ${o.slug}: ${o.problems.join(" ")}`));
  }
  lines.push("");
  return lines.join("\n");
}

/** Appends the cross-provider check section. Pure. */
export function appendCrosscheck(reportMd: string, sectionMd: string): string {
  return `${reportMd.trimEnd()}\n\n${sectionMd.trim()}\n`;
}
