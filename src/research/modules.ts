// Search modules (WS3.1): the four ways a research agent is told to look for things. An item names the
// modules it needs (`general-web`, `github-debug`, `stackoverflow`, `academic-papers`); the agent is handed
// exactly those modules' guidance before it searches. They are TypeScript constants, not prompt files, so
// they ship in the published package (`package.json` `files` is `dist` only).

import type { ResearchModule } from "../domain/intake.ts";
import type { PaperRecord } from "./dedupe.ts";

/** Guidance text per module. */
export const MODULE_GUIDE: Readonly<Record<ResearchModule, string>> = {
  "general-web": [
    "MODULE general-web -- use your built-in web search and fetch tools.",
    "- Prefer primary sources: official documentation, standards, vendor pages, release notes, source repositories.",
    "- Open and read the page; never cite from a search snippet alone.",
    "- Record the version or date each fact is current as of. Prefer material from the research time range.",
    "- A fact you could not open and read yourself must carry the [uncertain] marker.",
  ].join("\n"),
  "github-debug": [
    "MODULE github-debug -- for 'why does X break / behave like Y' questions.",
    "- Search the project's GitHub issues, discussions, release notes and changelog (e.g. site:github.com <project> <symptom>).",
    "- Prefer closed issues with a maintainer answer or a linked fix; note the version where it was fixed or changed.",
    "- Cite the issue/PR URL (type repo). An unconfirmed workaround from a comment is [uncertain].",
  ].join("\n"),
  stackoverflow: [
    "MODULE stackoverflow -- for practical how-to questions.",
    "- Search Stack Overflow / Stack Exchange (e.g. site:stackoverflow.com <question>).",
    "- Treat answers as SECONDARY: check the answer's date and the versions it assumes, prefer accepted and high-score answers,",
    "  and corroborate against official documentation. Uncorroborated claims are [uncertain]. Cite as type forum.",
  ].join("\n"),
  "academic-papers": [
    "MODULE academic-papers -- candidate papers were already retrieved for you (below) from arXiv and OpenAlex.",
    "- Treat them as leads: read the abstract, then cite a paper (type paper) only if it is genuinely relevant.",
    "- You may search for more with your web tools. Never cite a paper you have not seen listed below or opened yourself.",
    "- If none are relevant, say so plainly in the summary; that is a valid result.",
  ].join("\n"),
};

/** The guidance block for `modules`, in the given order, duplicates removed. */
export function modulesPrompt(modules: readonly ResearchModule[]): string {
  return [...new Set(modules)].map((m) => MODULE_GUIDE[m]).join("\n\n");
}

/** Renders paper leads for the `academic-papers` module. Pure. Content is untrusted third-party text. */
export function renderPaperLeads(papers: readonly PaperRecord[], max = 6): string {
  if (papers.length === 0) return "(No candidate papers were found for this topic.)";
  return papers
    .slice(0, max)
    .map((p, i) => {
      const ids = [p.doi !== null ? `doi:${p.doi}` : null, p.arxivId !== null ? `arXiv:${p.arxivId}` : null].filter((x) => x !== null).join(", ");
      return [
        `[${String(i + 1)}] ${p.title}${p.year !== null ? ` (${String(p.year)})` : ""}${p.citedByCount !== null ? ` -- cited ${String(p.citedByCount)}x` : ""}`,
        `    ${p.url}${ids !== "" ? `  (${ids})` : ""}`,
        `    ${p.abstract.slice(0, 500)}${p.abstract.length > 500 ? "..." : ""}`,
      ].join("\n");
    })
    .join("\n");
}
