// Web documentation search is MANDATORY in the spec phase (WS3.2): official docs for every library,
// framework or API named in the locked PRD. A spec with zero documentation sources fails the phase.
// This module only does the accounting; the searching is done by the `docs` research items.

import { StageError } from "../domain/errors.ts";
import type { Outline, ResearchSource } from "../domain/research.ts";
import { ResearchSourceSchema } from "../domain/research.ts";
import type { EventSink } from "../osa/events.ts";

/** One distinct official-documentation source and which item found it. */
export interface DocSource {
  readonly title: string;
  readonly url: string;
  readonly itemSlug: string;
}

/** The documentation picture across all item results. */
export interface DocsReport {
  readonly sources: readonly DocSource[];
  /** Titles of docs items that yielded at least one official-docs source. */
  readonly covered: readonly string[];
  /** Titles of docs items that yielded none (their targets are un-sourced). */
  readonly uncovered: readonly string[];
}

/** The valid sources cited by one result object. Pure. */
export function sourcesOf(result: Record<string, unknown> | null): ResearchSource[] {
  const raw = result?.["sources"];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((s) => {
    const p = ResearchSourceSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
}

/** Collects official-docs sources (de-duplicated by URL) and per-docs-item coverage. Pure. */
export function collectDocs(outline: Outline, results: ReadonlyMap<string, Record<string, unknown> | null>): DocsReport {
  const byUrl = new Map<string, DocSource>();
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const item of outline.items) {
    const docs = sourcesOf(results.get(item.slug) ?? null).filter((s) => s.type === "official-docs");
    for (const s of docs) if (!byUrl.has(s.url)) byUrl.set(s.url, { title: s.title, url: s.url, itemSlug: item.slug });
    if (item.kind === "docs") (docs.length > 0 ? covered : uncovered).push(item.title);
  }
  return { sources: [...byUrl.values()], covered, uncovered };
}

/**
 * Enforces the mandatory-documentation rule. Emits `research_docs_checked` first (so a failure is still
 * logged), then throws {@link StageError} when `required` and there are zero official-docs sources.
 */
export async function assertDocsPresent(report: DocsReport, required: boolean, events: EventSink): Promise<void> {
  await events.emit("research_docs_checked", { sources: report.sources.length, covered: report.covered.length, uncovered: report.uncovered, required });
  if (required && report.sources.length === 0) {
    throw new StageError(
      "The spec phase found zero official-documentation sources. Documentation search is mandatory (research.docsRequired): " +
        "a spec without a single documentation source fails the phase.",
      { uncovered: report.uncovered },
    );
  }
}
