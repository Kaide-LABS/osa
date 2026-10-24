// `osa memory`: the project-memory view (`.osa/memory`, read-only) plus the global-memory subcommands
// `search` / `save` / `forget` (docs/osa/memory-phase1/SPEC.md). The global store is `node:sqlite`-backed and is
// imported LAZILY inside the run function (only when a global subcommand is actually used), so it never enters the
// CLI's static import graph when memory is unused. The project-memory path is unchanged.

import { ExitCode, UsageError } from "../domain/errors.ts";
import { MEMORY_CATEGORIES, MEMORY_DIR_REL, readFacts } from "../memory/store.ts";

const KINDS = ["fact", "decision", "note"] as const;
type Kind = (typeof KINDS)[number];

export type MemoryCommandOptions =
  | { readonly sub: "show"; readonly repoDir: string; readonly json: boolean }
  | { readonly sub: "search"; readonly query: string; readonly project: string | null; readonly limit: number; readonly json: boolean }
  | { readonly sub: "save"; readonly text: string; readonly project: string | null; readonly factKind: Kind; readonly json: boolean }
  | { readonly sub: "forget"; readonly project: string | null; readonly all: boolean; readonly yes: boolean; readonly json: boolean }
  | { readonly sub: "dashboard"; readonly out: string | null; readonly project: string | null; readonly json: boolean }
  | { readonly sub: "export"; readonly out: string | null; readonly project: string | null; readonly json: boolean }
  | { readonly sub: "import"; readonly file: string; readonly project: string | null; readonly json: boolean };

/** Where the dashboard and the export go when no `--out` is given: the current folder, so the person can find them. */
export const DEFAULT_DASHBOARD_FILE = "osa-memory-dashboard.html";
export const DEFAULT_EXPORT_FILE = "osa-memory-export.json";

/** The project-memory view: print `.osa/memory` for the repo. Unchanged from the original `osa memory`. */
async function runShow(opts: { readonly repoDir: string; readonly json: boolean }): Promise<{ text: string; exitCode: number }> {
  const facts = await readFacts(opts.repoDir);
  if (opts.json) return { text: `${JSON.stringify({ facts }, null, 2)}\n`, exitCode: ExitCode.OK };
  if (facts.length === 0) return { text: `No project memory yet (${MEMORY_DIR_REL}). It is written at the end of each osa run.\n`, exitCode: ExitCode.OK };
  const lines: string[] = [];
  for (const c of MEMORY_CATEGORIES) {
    const mine = facts.filter((f) => f.category === c);
    if (mine.length === 0) continue;
    lines.push(`${c} (${String(mine.length)}):`, ...mine.map((f) => `  - ${f.text}`), "");
  }
  return { text: `${lines.join("\n")}`, exitCode: ExitCode.OK };
}

/** Dispatches `osa memory [search|save|forget|<show>]`. */
export async function runMemoryCommand(opts: MemoryCommandOptions): Promise<{ text: string; exitCode: number }> {
  if (opts.sub === "show") return runShow(opts);

  if (opts.sub === "dashboard" || opts.sub === "export" || opts.sub === "import") {
    // Lazy, like the store itself: neither the page renderer nor node:sqlite loads unless one of these runs.
    const dash = await import("../memory/global/dashboard.ts");
    const { readFile, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    if (opts.sub === "import") {
      const r = dash.importExport(await readFile(opts.file, "utf8"), opts.project !== null ? { project: opts.project } : {});
      if (opts.json) return { text: `${JSON.stringify(r, null, 2)}\n`, exitCode: ExitCode.OK };
      const refused = r.refused === 0 ? "" : ` ${String(r.refused)} were refused by the same checks as \`osa memory save\` (a secret, an instruction, hidden text or a bad label) and were not stored.`;
      return { text: `Imported ${String(r.total)} fact(s): ${String(r.saved)} new, ${String(r.deduped)} already present.${refused}\n`, exitCode: ExitCode.OK };
    }
    const data = dash.readDashboardData(opts.project !== null ? { project: opts.project, ...(opts.sub === "export" ? { limit: 1_000_000 } : {}) } : opts.sub === "export" ? { limit: 1_000_000 } : {});
    const target = resolve(opts.out ?? (opts.sub === "dashboard" ? DEFAULT_DASHBOARD_FILE : DEFAULT_EXPORT_FILE));
    await writeFile(target, opts.sub === "dashboard" ? dash.renderDashboard(data) : `${JSON.stringify(dash.buildExport(data), null, 2)}\n`, "utf8");
    if (opts.json) return { text: `${JSON.stringify({ file: target, facts: data.facts.length, total: data.total, projects: data.projects.length }, null, 2)}\n`, exitCode: ExitCode.OK };
    const where = opts.sub === "dashboard" ? `Open it in a browser: ${pathToFileURL(target).href}` : "Move it to another machine and run `osa memory import <file>` there.";
    return { text: `Wrote ${opts.sub === "dashboard" ? "the memory dashboard" : "the export"} (${String(data.facts.length)} fact(s), ${String(data.projects.length)} project(s)) to ${target}\n${where}\n`, exitCode: ExitCode.OK };
  }

  // Lazy: the global store (and node:sqlite) loads only when a global subcommand runs.
  const { saveFact, searchMemory, forgetMemory } = await import("../memory/global/memory.ts");

  if (opts.sub === "search") {
    const results = searchMemory({ query: opts.query, ...(opts.project !== null ? { project: opts.project } : {}), limit: opts.limit });
    if (opts.json) return { text: `${JSON.stringify({ results }, null, 2)}\n`, exitCode: ExitCode.OK };
    if (results.length === 0) return { text: "No matching facts.\n", exitCode: ExitCode.OK };
    const lines = results.map((r) => `- [${r.kind}] (${r.project}) ${r.snippet}`);
    return { text: `${lines.join("\n")}\n`, exitCode: ExitCode.OK };
  }

  if (opts.sub === "save") {
    const r = saveFact({ text: opts.text, project: opts.project ?? "default", kind: opts.factKind });
    if (opts.json) return { text: `${JSON.stringify(r, null, 2)}\n`, exitCode: ExitCode.OK };
    const redacted = r.redactions.length === 0 ? "" : ` (redacted: ${r.redactions.join(", ")})`;
    const verb = r.deduped ? "already present (refreshed)" : "saved";
    return { text: `Fact ${verb}: ${r.id}${redacted}\n`, exitCode: ExitCode.OK };
  }

  // forget
  if (opts.all && opts.project !== null) throw new UsageError("memory forget: give --project <name> OR --all, not both (--all would wipe every project).");
  if (opts.all && !opts.yes) throw new UsageError("memory forget --all requires --yes.");
  if (!opts.all && opts.project === null) throw new UsageError("memory forget requires --project <name> or --all.");
  const r = opts.all ? forgetMemory({ all: true }) : forgetMemory({ project: opts.project as string });
  if (opts.json) return { text: `${JSON.stringify({ forgotten: r.facts, scope: opts.all ? "all" : opts.project }, null, 2)}\n`, exitCode: ExitCode.OK };
  const scope = opts.all ? "all projects" : `project "${opts.project as string}"`;
  return { text: `Forgot ${String(r.facts)} fact(s) from ${scope}.\n`, exitCode: ExitCode.OK };
}
