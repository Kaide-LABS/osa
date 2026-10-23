// Builds `outline.yaml` and `fields.yaml` from the LOCKED baby PRD alone -- no prompts, no questions
// (OSA_DIRECTIVE.md WS3.2). Every decision the Deep-Research skills would have paused to ask the human about
// (outline confirmation, time range, existing fields, batch size, approve-next-batch) is already settled in
// the PRD's research plan and the config, so this is a pure function and research runs unattended.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OutlineSchema, FieldsFileSchema } from "../domain/research.ts";
import type { FieldSpec, FieldsFile, Outline, OutlineItem } from "../domain/research.ts";
import type { BabyPrd, ResearchModule } from "../domain/intake.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import { fromYaml, toYaml } from "./yaml.ts";

/** Slugs written by tools rather than agents (`results/academic-papers.json`, `results/prior-art.json`); no outline item may use them. */
export const RESERVED_RESULT_SLUGS: readonly string[] = ["academic-papers", "prior-art"];

/** Slug for a documentation target, e.g. "Python 3 argparse module" -> "python-3-argparse-module". */
export function slugify(text: string): string {
  const s = text
    .replace(/https?:\/\/\S+/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s === "" ? "item" : s;
}

/** The result-field schema shared by every item. */
export const COMMON_FIELDS: readonly FieldSpec[] = [
  { name: "summary", description: "2-5 sentences answering the item's question for THIS build.", type: "string", required: true },
  { name: "key_findings", description: "Concrete, verifiable findings (versions, signatures, limits, dates).", type: "string[]", required: true },
  { name: "recommendations", description: "What the build should do, and what it should avoid.", type: "string[]", required: true },
  { name: "as_of", description: "The date or version the information is current as of.", type: "string", required: true },
  { name: "sources", description: "Every source relied on: title, url, type (official-docs|paper|repo|article|forum|other), and a short supporting quote.", type: "sources", required: true },
];

/** Extra fields for a documentation item. */
export const DOCS_FIELDS: readonly FieldSpec[] = [
  { name: "current_version", description: "The current stable version of the library/framework/API.", type: "string", required: true },
  { name: "api_surface", description: "The commands/functions/endpoints/config this build will actually use.", type: "string[]", required: true },
  { name: "pitfalls", description: "Breaking changes, deprecations and known gotchas in the research time range.", type: "string[]", required: true },
];

/** Builds the outline for `prd`. Pure and deterministic. */
export function buildOutline(prd: BabyPrd, config: OsaConfig): Outline {
  const plan = prd.researchPlan;
  const usedSlugs = new Set<string>(RESERVED_RESULT_SLUGS);
  const unique = (slug: string): string => {
    let s = slug;
    let n = 2;
    while (usedSlugs.has(s)) s = `${slug}-${String(n++)}`;
    usedSlugs.add(s);
    return s;
  };

  const items: OutlineItem[] = [];
  // Mandatory documentation items first: official docs for every named library/framework/API.
  for (const target of plan.docsTargets) {
    items.push({
      slug: unique(`docs-${slugify(target)}`),
      title: `Official documentation: ${target}`,
      question:
        `Find the OFFICIAL documentation for "${target}": its current stable version, how it is installed or enabled, ` +
        `the API surface this build will use, and any breaking changes or pitfalls in the ${plan.timeRange}.`,
      kind: "docs",
      modules: ["general-web"],
    });
  }
  for (const it of plan.items) {
    const modules: ResearchModule[] = config.research.academic ? [...it.modules] : it.modules.filter((m) => m !== "academic-papers");
    items.push({
      slug: unique(it.slug),
      title: it.title,
      question: it.question,
      kind: "research",
      modules: modules.length > 0 ? modules : ["general-web"],
    });
  }

  return OutlineSchema.parse({
    topic: plan.topic,
    items,
    execution: {
      timeRange: plan.timeRange,
      batchSize: config.research.batchSize,
      resume: true,
      docsRequired: config.research.docsRequired,
      academic: { enabled: config.research.academic, queries: config.research.academic ? plan.academicQueries : [] },
      githubLookup: { enabled: config.research.githubLookup, queries: config.research.githubLookup ? plan.priorArtQueries : [] },
    },
  });
}

/** Builds the field schema for `outline`. Pure and deterministic. */
export function buildFields(outline: Outline): FieldsFile {
  const byItem: Record<string, FieldSpec[]> = {};
  for (const it of outline.items) {
    if (it.kind === "docs") byItem[it.slug] = [...DOCS_FIELDS];
  }
  return FieldsFileSchema.parse({ common: [...COMMON_FIELDS], byItem });
}

/** The full field list an item's result must satisfy. */
export function fieldsFor(fields: FieldsFile, slug: string): FieldSpec[] {
  return [...fields.common, ...(fields.byItem[slug] ?? [])];
}

/** Writes both files under `researchDirAbs` (created if needed). */
export async function writeOutlineFiles(researchDirAbs: string, outline: Outline, fields: FieldsFile): Promise<void> {
  await mkdir(researchDirAbs, { recursive: true });
  await writeFile(`${researchDirAbs}/outline.yaml`, `# OSA research outline -- generated from the locked baby PRD. Do not hand-edit mid-run.\n${toYaml(outline)}`, "utf8");
  await writeFile(`${researchDirAbs}/fields.yaml`, `# OSA research field schema -- every item result must cover these fields.\n${toYaml(fields)}`, "utf8");
}

/** Reads and validates both files back (used on resume). */
export async function readOutlineFiles(researchDirAbs: string): Promise<{ outline: Outline; fields: FieldsFile }> {
  const outline = OutlineSchema.parse(fromYaml(await readFile(`${researchDirAbs}/outline.yaml`, "utf8")));
  const fields = FieldsFileSchema.parse(fromYaml(await readFile(`${researchDirAbs}/fields.yaml`, "utf8")));
  return { outline, fields };
}

