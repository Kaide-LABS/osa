// The one place that turns the `index.engine` setting into a working code-search engine (Suite 7e). The auto-inserted "where to look first"
// block, the `code_search` MCP tool and `osa search` all go through here, so they share the same fallback, the same confidence guard and
// the same `code_search_engine` event. Nothing here can make a search fail: if codebase-memory-mcp cannot start or index, the lexical engine
// answers and the answer says so (engine "lexical-fallback", reason names the cause).

import type { CbmEngine } from "./cbm/engine.ts";
import { LexicalEngine } from "./engine.ts";
import type { CodeSearchEngine, EngineAnswer } from "./engine.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { EventSink } from "../osa/events.ts";

/** What a caller needs to know about where a search came from; carried by the event and shown to agents when it is not high. */
export interface SearchProvenance {
  readonly engine: string;
  readonly confidence: EngineAnswer["confidence"];
  readonly abstained: boolean;
  readonly reason: string;
}

/** The answer to a structure question; `available` is false when the CBM engine is not the one configured or could not start. */
export interface StructureAnswer {
  readonly available: boolean;
  readonly engine: string;
  readonly note: string | null;
  readonly data: unknown;
}

/** A search engine chosen by config, opened lazily on the first search. */
export interface CodeSearcher {
  search(query: string, opts: { readonly k: number; readonly purpose: string }): Promise<EngineAnswer>;
  /** The graph views only the CBM engine has: the project overview, and what changed since the previous index with what depends on it. */
  structure(view: "architecture" | "changes", scope?: "files" | "impact" | "tests"): Promise<StructureAnswer>;
  close(): Promise<void>;
}

export interface CodeSearcherOptions {
  readonly repoDir: string;
  readonly index: OsaConfig["index"];
  readonly events?: EventSink;
  /** Test seam: replaces the CBM opener. */
  readonly openCbm?: () => Promise<CodeSearchEngine>;
}

/** Why CBM is not configured, or null when it is. Pure. */
export function cbmConfigProblem(index: OsaConfig["index"]): string | null {
  if (index.cbm.binaryPath === "" || index.cbm.workDir === "") {
    return "index.cbm.binaryPath and index.cbm.workDir must both be set to use the codebase-memory-mcp engine (see docs/osa/CBM_NOTES.md)";
  }
  return null;
}

/** Builds the searcher for `index.engine`. Opening is lazy and happens at most once; a failure is remembered and every search falls back. */
export function createCodeSearcher(o: CodeSearcherOptions): CodeSearcher {
  const lexical = new LexicalEngine(o.repoDir, o.events !== undefined ? { events: o.events } : {});
  let cbm: Promise<CodeSearchEngine | null> | null = null;
  let unavailable: string | null = null;

  const openCbm = (): Promise<CodeSearchEngine | null> => {
    cbm ??= (async () => {
      const problem = cbmConfigProblem(o.index);
      if (problem !== null) {
        unavailable = problem;
        return null;
      }
      try {
        if (o.openCbm !== undefined) return await o.openCbm();
        // Loaded here and only here: with `index.engine: "lexical"` (the default) no CBM module is ever imported (WS10).
        const [{ CbmEngine }, { TUNED_PER_CHANNEL, TUNED_TUNING }] = await Promise.all([import("./cbm/engine.ts"), import("./fusion.ts")]);
        return await CbmEngine.open({
          repoDir: o.repoDir,
          paths: { binaryPath: o.index.cbm.binaryPath, workDir: o.index.cbm.workDir },
          indexMode: o.index.cbm.indexMode,
          tuning: TUNED_TUNING,
          perChannel: TUNED_PER_CHANNEL,
          lexical,
        });
      } catch (err) {
        unavailable = err instanceof Error ? err.message : String(err);
        return null;
      }
    })();
    return cbm;
  };

  return {
    async search(query, { k, purpose }) {
      const requested = o.index.engine;
      let answer: EngineAnswer;
      if (requested === "cbm") {
        const engine = await openCbm();
        if (engine !== null) {
          try {
            await engine.refresh();
            answer = await engine.search(query, { k });
          } catch (err) {
            answer = { ...(await lexical.search(query, { k })), engine: "lexical-fallback", confidence: "low", reason: `codebase-memory-mcp failed during the search (${err instanceof Error ? err.message : String(err)}); answered by the local index` };
          }
        } else {
          answer = { ...(await lexical.search(query, { k })), engine: "lexical-fallback", confidence: "low", reason: `codebase-memory-mcp is not available (${unavailable ?? "unknown"}); answered by the local index` };
        }
      } else {
        answer = await lexical.search(query, { k });
      }
      await o.events?.emit("code_search_engine", {
        requested,
        engine: answer.engine,
        confidence: answer.confidence,
        abstained: answer.abstained,
        reason: answer.reason,
        hits: answer.hits.length,
        stale: answer.stale,
        ms: answer.ms,
        purpose,
      });
      return answer;
    },
    async structure(view, scope = "impact") {
      if (o.index.engine !== "cbm") return { available: false, engine: "lexical", note: "the architecture and change views need index.engine \"cbm\" (docs/osa/CBM_NOTES.md)", data: null };
      const engine = await openCbm();
      if (engine === null) return { available: false, engine: "lexical-fallback", note: `codebase-memory-mcp is not available (${unavailable ?? "unknown"})`, data: null };
      const graph = engine as unknown as Partial<Pick<CbmEngine, "architecture" | "changes">>;
      try {
        await engine.refresh();
        if (view === "architecture" && graph.architecture !== undefined) return { available: true, engine: "cbm", note: null, data: await graph.architecture() };
        if (view === "changes" && graph.changes !== undefined) {
          const c = await graph.changes(scope);
          return { available: true, engine: "cbm", note: c.note, data: { since: c.since, scope, ...c.result } };
        }
        return { available: false, engine: "cbm", note: "this engine has no such view", data: null };
      } catch (err) {
        return { available: false, engine: "cbm", note: `the ${view} view failed: ${err instanceof Error ? err.message : String(err)}`, data: null };
      }
    },
    async close() {
      const engine = cbm === null ? null : await cbm;
      cbm = null;
      await engine?.close();
    },
  };
}

/** A line telling an agent how far to trust the list, or "" when nothing needs saying. Pure. */
export function caveatFor(p: SearchProvenance): string {
  if (p.engine === "lexical-fallback") return `Confidence: LOW -- the main index was not used (${p.reason}). Treat these as leads and confirm with grep before relying on them.`;
  if (p.abstained || p.confidence === "low") return `Confidence: LOW -- ${p.reason}. Treat these as leads and confirm with grep before relying on them.`;
  if (p.confidence === "medium") return `Confidence: medium -- ${p.reason}. Check the first hit against the file before building on it.`;
  return "";
}
