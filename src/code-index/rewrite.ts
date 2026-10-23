// Query rewriting for code search. A person (or an agent) asks "which function stops a command silently doing nothing when it was started
// through a symbolic link?"; the code says `isEntryPoint` and `realpathSync`. The text-search channel of an index can only match what the code says,
// so a model is asked, once per question, to translate the question into the IDENTIFIERS and KEYWORDS the code is likely to contain. A cheap model
// is enough and the answer is cached on disk, so a question costs one small call the first time and nothing after.
//
// The rewrite only ADDS terms: the original question is always still searched, so a bad rewrite can lower precision but never remove what the
// plain query would have found. Optionally the model is shown the list of file paths of the project (cheap, and it makes guessed names far better).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";
import { extractJsonObject } from "../osa/intake.ts";

/** What the rewrite adds to a query. */
export interface QueryRewrite {
  /** Likely names as written in code (function, class, variable, file names). */
  readonly identifiers: readonly string[];
  /** Plain words likely to appear in code or comments (not the question's own filler). */
  readonly keywords: readonly string[];
}

const MAX_TERMS = 8;
const MAX_TERM_CHARS = 60;
/** A term the engines may safely use as a search pattern: word characters, dots, dashes, slashes. Pure. */
const SAFE_TERM = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t.length < 2 || t.length > MAX_TERM_CHARS || !SAFE_TERM.test(t)) continue;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** Parses the model's reply; `null` when it holds no usable term. Pure. */
export function parseRewrite(text: string): QueryRewrite | null {
  let json: unknown;
  try {
    json = extractJsonObject(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const identifiers = cleanList(o["identifiers"]);
  const keywords = cleanList(o["keywords"]);
  return identifiers.length + keywords.length === 0 ? null : { identifiers, keywords };
}

/** The prompt. `paths` (optional) are the project's file paths, shown so that guessed names can follow the project's own vocabulary. Pure. */
export function buildRewritePrompt(question: string, ctx: { readonly language?: string; readonly paths?: readonly string[] } = {}): string {
  const lines = [
    "You help a code search tool. A developer asked a question about a codebase. The search can only match text that is literally in the code.",
    "List what the answer's code most likely CONTAINS: names as they would be written (camelCase, snake_case, PascalCase function, class, variable or file names) and plain keywords that would appear in the code or its comments. Prefer specific names over generic words. Guess several spellings if unsure.",
    `Reply with ONE JSON object and nothing else: {"identifiers": [up to ${String(MAX_TERMS)} names], "keywords": [up to ${String(MAX_TERMS)} lowercase words]}`,
    "Do not repeat words that are only part of the question's phrasing (how, where, function, code, program).",
  ];
  if (ctx.language !== undefined) lines.push(`The codebase is mostly ${ctx.language}.`);
  if (ctx.paths !== undefined && ctx.paths.length > 0) lines.push("", "File paths in the project (use them to guess real names):", ...ctx.paths);
  lines.push("", "Question:", question.trim());
  return lines.join("\n");
}

export interface RewriterOptions {
  readonly textCall: TextCall;
  readonly provider: ProviderId;
  /** The model to ask (a small, fast one is enough); `null` = the provider's default. */
  readonly model: string | null;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Where answers are cached across runs (a JSON object file); omit for no disk cache. */
  readonly cacheFile?: string;
  readonly language?: string;
  readonly paths?: readonly string[];
}

/** A rewriter: returns the rewrite for a question, or `null` when the model is unavailable or useless (the search then runs unchanged). */
export type Rewriter = (question: string) => Promise<QueryRewrite | null>;

const keyOf = (question: string, o: RewriterOptions): string =>
  createHash("sha256").update(`${o.model ?? ""}\u0000${o.paths === undefined ? "nopaths" : String(o.paths.length)}\u0000${question.trim()}`).digest("hex").slice(0, 32);

/** Builds a rewriter with an in-memory and optional on-disk cache. Never throws. */
export function makeRewriter(o: RewriterOptions): Rewriter {
  let loaded: Record<string, QueryRewrite | null> | null = null;
  const load = async (): Promise<Record<string, QueryRewrite | null>> => {
    if (loaded !== null) return loaded;
    loaded = {};
    if (o.cacheFile !== undefined) {
      try {
        loaded = JSON.parse(await readFile(o.cacheFile, "utf8")) as Record<string, QueryRewrite | null>;
      } catch {
        // no cache yet
      }
    }
    return loaded;
  };
  return async (question) => {
    const cache = await load();
    const key = keyOf(question, o);
    if (key in cache) return cache[key] ?? null;
    let result: QueryRewrite | null = null;
    try {
      const call = await o.textCall(o.provider, { prompt: buildRewritePrompt(question, { ...(o.language !== undefined ? { language: o.language } : {}), ...(o.paths !== undefined ? { paths: o.paths } : {}) }), cwd: o.cwd, timeoutMs: o.timeoutMs, tier: "high-volume-low-effort", webSearch: false, modelOverride: o.model }, "query-rewrite");
      if (call.outcome.ok && call.outcome.text !== null) result = parseRewrite(call.outcome.text);
      else return null; // a failed call is not cached: the next question may work
    } catch {
      return null;
    }
    cache[key] = result;
    if (o.cacheFile !== undefined) {
      try {
        await mkdir(dirname(o.cacheFile), { recursive: true });
        await writeFile(o.cacheFile, JSON.stringify(cache), "utf8");
      } catch {
        // a cache that cannot be written is only a missed saving
      }
    }
    return result;
  };
}

/** Looks a rewrite up in a precomputed table (the evaluation harness uses this so a run is repeatable and costs no model calls). */
export function tableRewriter(table: Readonly<Record<string, QueryRewrite>>): Rewriter {
  return (question) => Promise.resolve(table[question] ?? null);
}
