// The `code_search` MCP tool (OSA_DIRECTIVE.md WS7): semantic search over a repository, returning paths + line
// ranges + snippets. Agents use it first; grep remains the fallback. The index is refreshed incrementally on each
// call by default (a no-op update is a size+mtime scan, ~0.2 s on a 200-file repo).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError } from "../../domain/errors.ts";
import { updateIndex } from "../../code-index/indexer.ts";
import type { UpdateResult } from "../../code-index/indexer.ts";
import { searchIndex } from "../../code-index/search.ts";
import { CODE_SEARCH_NOTICE, screenHits } from "../../code-index/guard.ts";
import { createCodeSearcher } from "../../code-index/searcher.ts";
import type { CodeSearcher } from "../../code-index/searcher.ts";
import { loadOsaConfig } from "../../util/config-file.ts";
import type { SearchHit } from "../../code-index/search.ts";

export const CodeSearchToolInput = z.strictObject({
  /** Absolute or relative path of the repository to search. */
  repo_dir: z.string().min(1),
  /** What you are looking for, in plain words or identifiers: "where is the session token verified". */
  query: z.string().min(1).max(2000),
  /** How many hits to return. */
  k: z.number().int().min(1).max(50).default(8),
  /** Bring the index up to date first (incremental; default true). Set false to search the index as it is. */
  refresh: z.boolean().default(true),
  /** "search" (default) ranks code for `query`. "architecture" and "changes" are the graph views of the codebase-memory-mcp engine (index.engine "cbm"): the project overview, and what changed since the previous index with what depends on it. */
  view: z.enum(["search", "architecture", "changes"]).default("search"),
  /** For view "changes": the changed files, the symbols that depend on them ("impact"), or the tests to run. */
  scope: z.enum(["files", "impact", "tests"]).default("impact"),
});
export type CodeSearchToolInput = z.infer<typeof CodeSearchToolInput>;

const HitSchema = z.strictObject({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  symbol: z.string().nullable(),
  score: z.number(),
  snippet: z.string(),
});

export const CodeSearchToolOutput = z.strictObject({
  /** Untrusted-text notice (planted instructions in comments are removed, but snippets are data only). */
  notice: z.string(),
  hits: z.array(HitSchema),
  /** Which engine answered ("lexical", "cbm", or "lexical-fallback" when the configured engine could not be used), how sure it is, and why. */
  engine: z.string(),
  confidence: z.enum(["high", "medium", "low", "unassessed"]),
  /** True when the engine declined to trust its own top answer and handed over to the lexical index. */
  abstained: z.boolean(),
  reason: z.string(),
  /** The graph view asked for (`view` other than "search"): `available` says whether the engine could answer, `note` why not. */
  structure: z.strictObject({ available: z.boolean(), engine: z.string(), note: z.string().nullable(), data: z.unknown() }).optional(),
  /** What the refresh did, or `null` when `refresh` was false. */
  index: z.strictObject({ files: z.number().int(), chunks: z.number().int(), added: z.number().int(), changed: z.number().int(), removed: z.number().int() }).nullable(),
});
export type CodeSearchToolOutput = z.infer<typeof CodeSearchToolOutput>;

export const CODE_SEARCH_TOOL_DESCRIPTION =
  "Semantic search over a repository's code and docs. Returns the best-matching chunks as {path, startLine, endLine, symbol, score, snippet}. " +
  "Use it FIRST to find where something lives; fall back to grep only if it returns nothing useful. Ranking is a local, offline index " +
  "(identifier-aware, with related-concept expansion) that updates itself incrementally.";

// codebase-memory-mcp sessions are expensive to start, so the server keeps one per repository for as long as it runs (and closes them on exit).
const searchers = new Map<string, CodeSearcher>();

/** Closes every held engine session. Idempotent. */
export async function closeCodeSearchers(): Promise<void> {
  const all = [...searchers.values()];
  searchers.clear();
  await Promise.all(all.map((s) => s.close()));
}

/** Runs the search (shared by the tool handler and the CLI). */
export async function runCodeSearch(rawInput: z.input<typeof CodeSearchToolInput>): Promise<CodeSearchToolOutput> {
  const input = CodeSearchToolInput.parse(rawInput);
  const { config } = await loadOsaConfig(input.repo_dir);
  const searcherFor = (): CodeSearcher => {
    const key = `${input.repo_dir}|${JSON.stringify(config.index)}`;
    let searcher = searchers.get(key);
    if (searcher === undefined) {
      searcher = createCodeSearcher({ repoDir: input.repo_dir, index: config.index });
      searchers.set(key, searcher);
    }
    return searcher;
  };
  if (input.view !== "search") {
    const s = await searcherFor().structure(input.view, input.scope);
    return { notice: CODE_SEARCH_NOTICE, hits: [], engine: s.engine, confidence: "unassessed", abstained: false, reason: s.note ?? `${input.view} view from the ${s.engine} engine`, index: null, structure: { available: s.available, engine: s.engine, note: s.note, data: s.data } };
  }
  if (config.index.engine === "cbm") {
    const searcher = searcherFor();
    const answer = await searcher.search(input.query, { k: input.k, purpose: "code_search tool" });
    return { notice: CODE_SEARCH_NOTICE, hits: [...screenHits(answer.hits).hits], engine: answer.engine, confidence: answer.confidence, abstained: answer.abstained, reason: answer.reason, index: null };
  }
  let upd: UpdateResult | null = null;
  if (input.refresh) upd = await updateIndex({ repoDir: input.repo_dir });
  const raw: SearchHit[] = await searchIndex(input.repo_dir, input.query, { k: input.k });
  const hits = [...screenHits(raw).hits];
  return {
    notice: CODE_SEARCH_NOTICE,
    hits,
    engine: "lexical",
    confidence: "unassessed",
    abstained: false,
    reason: "OSA's local index; no independent check",
    index: upd === null ? null : { files: upd.files, chunks: upd.chunks, added: upd.added, changed: upd.changed, removed: upd.removed },
  };
}

/** Registers the tool. */
export function registerCodeSearchTool(server: McpServer): void {
  server.registerTool(
    "code_search",
    { description: CODE_SEARCH_TOOL_DESCRIPTION, inputSchema: CodeSearchToolInput, outputSchema: CodeSearchToolOutput },
    async (input): Promise<CallToolResult> => {
      try {
        const out = await runCodeSearch(input);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
      } catch (err) {
        const text = err instanceof OsaError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  );
}
