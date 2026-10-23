// The independent signal the confidence guard leans on: a plain text probe that knows nothing about embeddings, graphs or BM25. For each query
// term it asks `git grep` (works outside a repository with --no-index) which files contain it, then ranks files by how many DISTINCT terms
// they contain. An engine's top hit that no literal term points to is exactly the "confident near-miss" the prior CBM spike found.

import { runProcess } from "../util/exec.ts";

/**
 * Never searched: the index's own storage (it contains every word of the codebase, so it would "match" every query -- found by the first eval run,
 * where it made the grep baseline return the index file first for 40 of 40 queries), dependency and build output, and raw chat transcripts.
 */
export const PROBE_EXCLUDES: readonly string[] = [".osa/index", ".git", "node_modules", "dist", "build", ".osa/chat-log", ".venv", "__pycache__"];

/** `git grep` pathspec arguments that exclude {@link PROBE_EXCLUDES}. Pure. */
export function excludeSpecs(): string[] {
  return ["--", ".", ...PROBE_EXCLUDES.map((p) => `:(exclude)${p}`)];
}

/** A file the probe found terms in. */
export interface ProbeFile {
  readonly file: string;
  /** Distinct query terms found in the file. */
  readonly distinct: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

/** The probe's answer. */
export interface ProbeResult {
  /** Best first: most distinct terms, then most matches, then path. */
  readonly files: readonly ProbeFile[];
  /** Fraction of the terms that occur anywhere in the tree (0 = none of the query's words exist in this codebase). */
  readonly coverage: number;
  readonly termsTried: number;
  /** False when git could not run (the guard then ignores this signal rather than treating it as a disagreement). */
  readonly available: boolean;
}

/** Parses `git grep -c` output ("path:count" lines). Pure. */
export function parseGrepCounts(stdout: string): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.lastIndexOf(":");
    if (i <= 0) continue;
    const count = Number(line.slice(i + 1));
    if (Number.isInteger(count) && count > 0) out.push({ file: line.slice(0, i).split(String.fromCharCode(92)).join("/"), count });
  }
  return out;
}

/** Options of {@link probeTerms}. */
export interface ProbeOptions {
  readonly spawn?: typeof runProcess;
  readonly maxTerms?: number;
}

/** Probes `dir` (any directory; no repository needed) for `terms`. Never throws. */
export async function probeTerms(dir: string, terms: readonly string[], opts: ProbeOptions = {}): Promise<ProbeResult> {
  const spawn = opts.spawn ?? runProcess;
  const used = [...new Set(terms)].slice(0, opts.maxTerms ?? 6);
  if (used.length === 0) return { files: [], coverage: 0, termsTried: 0, available: true };
  const byFile = new Map<string, { terms: Set<string>; matches: number }>();
  let found = 0;
  let available = true;
  const results = await Promise.all(
    used.map(async (t) => {
      const r = await spawn({ command: "git", args: ["grep", "--no-index", "-I", "-i", "-F", "-c", "-e", t, ...excludeSpecs()], cwd: dir, timeoutMs: 20_000, noShellFallback: true });
      return { t, r };
    }),
  );
  for (const { t, r } of results) {
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      available = false;
      continue;
    }
    const rows = parseGrepCounts(r.stdout);
    if (rows.length > 0) found += 1;
    for (const { file, count } of rows) {
      const e = byFile.get(file) ?? { terms: new Set<string>(), matches: 0 };
      e.terms.add(t);
      e.matches += count;
      byFile.set(file, e);
    }
  }
  const files = [...byFile.entries()]
    .map(([file, e]): ProbeFile => ({ file, distinct: e.terms.size, matches: e.matches, terms: [...e.terms] }))
    .sort((a, b) => b.distinct - a.distinct || b.matches - a.matches || a.file.localeCompare(b.file));
  return { files, coverage: available ? found / used.length : 0, termsTried: used.length, available };
}
