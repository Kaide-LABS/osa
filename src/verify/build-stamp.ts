// Build-freshness check. The MCP server (and any installed `osa`) runs the compiled `dist/`, which is git-ignored, so a
// checkout can easily run code older than its `src/` -- the live-run report found a server whose boundary scan lacked
// a rule that the source already had. `npm run build` writes `dist/build-stamp.json` (a hash of the compiled source
// set); `doctor` recomputes that hash from `src/` and warns when they differ, and warns when a long-running process
// started from an older stamp than the one on disk (it must be restarted). Pure Node built-ins; no network.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Files outside `src/` whose change alters the compiled output. */
const EXTRA_INPUTS = ["tsconfig.json", "tsconfig.build.json"] as const;

/** The stamp written into `dist/`. */
export interface BuildStamp {
  readonly schema_version: 1;
  readonly source_hash: string;
  readonly built_at: string;
  readonly file_count: number;
}

/** The outcome of {@link checkBuildFreshness}. */
export interface BuildFreshness {
  readonly status: "fresh" | "stale" | "missing" | "process-stale" | "not-applicable";
  readonly detail: string;
  readonly source_hash: string | null;
  readonly dist_hash: string | null;
}

/** The package root (the directory holding `src/`, `dist/` and `package.json`) for code running from either tree. */
export function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function listSourceFiles(dir: string, prefix: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) out.push(...listSourceFiles(`${dir}/${e.name}`, `${rel}/`));
    else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/** Hash of every compiled source file (tests excluded, as in `tsconfig.build.json`), line endings normalised. */
export function computeSourceHash(root: string): { readonly hash: string; readonly fileCount: number } {
  const files = [...listSourceFiles(`${root}/src`, "src/"), ...EXTRA_INPUTS].sort();
  const h = createHash("sha256");
  let count = 0;
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(`${root}/${rel}`, "utf8");
    } catch {
      continue;
    }
    h.update(`${rel}\0${createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")}\n`);
    count += 1;
  }
  return { hash: h.digest("hex"), fileCount: count };
}

/** Reads `dist/build-stamp.json`; `null` when absent or unreadable. */
export function readBuildStamp(root: string): BuildStamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${root}/dist/build-stamp.json`, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (o["schema_version"] !== 1 || typeof o["source_hash"] !== "string") return null;
    return { schema_version: 1, source_hash: o["source_hash"], built_at: String(o["built_at"] ?? ""), file_count: Number(o["file_count"] ?? 0) };
  } catch {
    return null;
  }
}

/** Writes `dist/build-stamp.json` for the current `src/`. Called by `scripts/stamp-build.mjs` after `tsc`. */
export function writeBuildStamp(root: string, now: Date = new Date()): BuildStamp {
  const { hash, fileCount } = computeSourceHash(root);
  const stamp: BuildStamp = { schema_version: 1, source_hash: hash, built_at: now.toISOString(), file_count: fileCount };
  writeFileSync(`${root}/dist/build-stamp.json`, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  return stamp;
}

/** The stamp this process started from, captured at module load (only meaningful when running from `dist/`). */
const RUNNING_FROM_DIST = import.meta.url.includes("/dist/");
const STARTUP_STAMP: BuildStamp | null = RUNNING_FROM_DIST ? readBuildStamp(packageRoot()) : null;

/** Options of {@link checkBuildFreshness}; each defaults to the real process. */
export interface FreshnessOptions {
  readonly root?: string;
  /** The stamp the current process started from, or `null`. */
  readonly startupStamp?: BuildStamp | null;
  readonly runningFromDist?: boolean;
}

/** Compares `dist/` with `src/` (and the running process with `dist/`). Never throws. */
export function checkBuildFreshness(opts: FreshnessOptions = {}): BuildFreshness {
  const root = opts.root ?? packageRoot();
  const running = opts.runningFromDist ?? RUNNING_FROM_DIST;
  const startup = opts.startupStamp !== undefined ? opts.startupStamp : STARTUP_STAMP;
  const hasSrc = listSourceFiles(`${root}/src`, "src/").length > 0;
  const stamp = readBuildStamp(root);
  if (!hasSrc) {
    return { status: "not-applicable", detail: "no src/ next to this install (a packaged build); nothing to compare", source_hash: null, dist_hash: stamp?.source_hash ?? null };
  }
  const { hash } = computeSourceHash(root);
  if (stamp === null) {
    return { status: "missing", detail: "dist/build-stamp.json is missing: dist/ was not built by this version of `npm run build`; run `npm run build`", source_hash: hash, dist_hash: null };
  }
  if (stamp.source_hash !== hash) {
    return { status: "stale", detail: "dist/ is older than src/ (the compiled code does not match the source); run `npm run build` and restart the MCP server", source_hash: hash, dist_hash: stamp.source_hash };
  }
  if (running && startup !== null && startup.source_hash !== stamp.source_hash) {
    return { status: "process-stale", detail: "this process started from an older build than the one now on disk; restart it (for the MCP server, restart the `osa` server)", source_hash: hash, dist_hash: stamp.source_hash };
  }
  return { status: "fresh", detail: "dist/ matches src/", source_hash: hash, dist_hash: stamp.source_hash };
}
