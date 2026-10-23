// `osa index` and `osa search`: build/refresh the semantic code index, and query it from the terminal. Both are thin
// wrappers over `src/code-index/**` (the same functions the `code_search` MCP tool uses).

import { updateIndex } from "../code-index/indexer.ts";
import type { UpdateResult } from "../code-index/indexer.ts";
import { renderIndexContext, searchIndex } from "../code-index/search.ts";
import { caveatFor, createCodeSearcher } from "../code-index/searcher.ts";
import { rewriteSeatFor } from "../code-index/rewrite-seat.ts";
import { loadOsaConfig } from "../util/config-file.ts";
import { applyFeatureFlags } from "../features/features.ts";
import type { FeatureFlags } from "../features/features.ts";
import type { SearchHit } from "../code-index/search.ts";
import { ExitCode } from "../domain/errors.ts";

export interface IndexCommandOptions {
  readonly repoDir: string;
  readonly json: boolean;
}

export interface SearchCommandOptions {
  readonly repoDir: string;
  readonly query: string;
  readonly k: number;
  readonly json: boolean;
  /** Refresh the index first (default true). */
  readonly refresh: boolean;
  /** `--index-engine lexical|cbm` for this search; wins over `osa.config.json`. */
  readonly features?: FeatureFlags;
}

/** Brings the index up to date; returns the text to print. */
export async function runIndexCommand(opts: IndexCommandOptions): Promise<{ text: string; exitCode: number; result: UpdateResult }> {
  const result = await updateIndex({ repoDir: opts.repoDir });
  const text = opts.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `osa index -- ${String(result.files)} file(s), ${String(result.chunks)} chunk(s) ` +
      `(${result.rebuiltAll ? "full build" : `${String(result.added)} added, ${String(result.changed)} changed, ${String(result.removed)} removed, ${String(result.unchanged)} unchanged`}) in ${String(result.ms)} ms\n`;
  return { text, exitCode: ExitCode.OK, result };
}

/** Searches the index; returns the text to print. Exit 0 even with no hits (an empty answer is an answer). */
export async function runSearchCommand(opts: SearchCommandOptions): Promise<{ text: string; exitCode: number; hits: SearchHit[] }> {
  const config = applyFeatureFlags((await loadOsaConfig(opts.repoDir)).config, opts.features ?? {});
  if (config.index.engine === "cbm") {
    const searcher = createCodeSearcher({ repoDir: opts.repoDir, index: config.index, rewriteSeat: rewriteSeatFor(config) });
    try {
      const answer = await searcher.search(opts.query, { k: opts.k, purpose: "osa search" });
      const hits = [...answer.hits];
      const caveat = caveatFor(answer);
      const head = `engine: ${answer.engine}, confidence: ${answer.confidence}${answer.abstained ? " (abstained)" : ""} -- ${answer.reason}\n`;
      const text = opts.json
        ? `${JSON.stringify({ engine: answer.engine, confidence: answer.confidence, abstained: answer.abstained, reason: answer.reason, hits }, null, 2)}\n`
        : hits.length === 0
          ? `${head}No matches. Try different words, or fall back to grep.\n`
          : `${head}${renderIndexContext(hits, 3, caveat).replace(/^## .*\n\n.*\n/, "")}`;
      return { text, exitCode: ExitCode.OK, hits };
    } finally {
      await searcher.close();
    }
  }
  if (opts.refresh) await updateIndex({ repoDir: opts.repoDir });
  const hits = await searchIndex(opts.repoDir, opts.query, { k: opts.k });
  const text = opts.json ? `${JSON.stringify({ hits }, null, 2)}\n` : hits.length === 0 ? "No matches. Try different words, or fall back to grep.\n" : `${renderIndexContext(hits, 3).replace(/^## .*\n\n.*\n\n/, "")}`;
  return { text, exitCode: ExitCode.OK, hits };
}
