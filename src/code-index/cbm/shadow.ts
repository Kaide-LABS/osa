// The shadow tree: what codebase-memory-mcp actually indexes. CBM honours the repo's .gitignore and a built-in skip list that a `.cbmignore`
// negation cannot override (docs/cbmignore.md, "Precedence"), so it can never see the spec artifacts a project ignores -- the prior spike's
// finding (ii). Instead of fighting that, OSA indexes a COPY it controls: the repo's tracked and unignored files, plus every spec artifact
// (src/code-index/spec-artifacts.ts), minus secrets and minus every .gitignore/.cbmignore. The copy lives under CBM's allowed root, outside
// the repository, so nothing is ever written into the user's project.
//
// The manifest ({path -> sha256, size, mtime} of what the shadow holds) is the freshness oracle: before an answer is trusted, the live file's
// hash is compared with the manifest's. A mismatch means the index describes a file that has since changed.

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isIndexable, listCandidateFiles } from "../indexer.ts";
import { isSecretPath, isSpecArtifact, listSpecArtifacts } from "../spec-artifacts.ts";
import { sha256File } from "../../util/hash.ts";
import { runProcess } from "../../util/exec.ts";

/** Per-file bookkeeping. */
export interface ShadowFile {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** What the shadow holds. */
export interface ShadowManifest {
  readonly version: 1;
  readonly repoDir: string;
  readonly files: Record<string, ShadowFile>;
  readonly syncedAt: string;
}

/** The outcome of a sync. */
export interface SyncResult {
  readonly shadowDir: string;
  readonly copied: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly files: number;
  /** Paths copied or removed (for the index to refresh). */
  readonly changedPaths: readonly string[];
  readonly manifest: ShadowManifest;
  /** The shadow's own git history (so CBM's `detect_changes` has something to diff): the commit now, and the one before it. Null when git is unavailable. */
  readonly snapshot: ShadowSnapshot;
}

/** The shadow tree's two most recent snapshot commits. */
export interface ShadowSnapshot {
  readonly head: string | null;
  readonly previous: string | null;
}

/**
 * Commits the shadow's current content to the shadow's own private git repository (created on first use), but only when something changed since the
 * last snapshot. The repository lives inside the shadow under CBM's allowed root, never in the user's project. Never throws: no git means no snapshots.
 */
export async function snapshotShadow(shadowDir: string, spawn: typeof runProcess = runProcess): Promise<ShadowSnapshot> {
  const git = async (...args: string[]): Promise<{ ok: boolean; out: string }> => {
    const r = await spawn({ command: "git", args: ["-c", "user.name=osa", "-c", "user.email=osa@localhost", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], cwd: shadowDir, timeoutMs: 60_000, noShellFallback: true });
    return { ok: r.exitCode === 0, out: r.stdout.trim() };
  };
  const exists = await stat(`${shadowDir}/.git`).then(() => true, () => false);
  if (!exists && !(await git("init", "-q", "-b", "main")).ok) return { head: null, previous: null };
  if (!(await git("add", "-A")).ok) return { head: null, previous: null };
  const before = await git("rev-parse", "--verify", "-q", "HEAD");
  const dirty = !before.ok || !(await git("diff", "--cached", "--quiet")).ok;
  if (dirty && !(await git("commit", "-q", "-m", "osa shadow snapshot", "--allow-empty")).ok) return { head: before.ok ? before.out : null, previous: null };
  const head = await git("rev-parse", "--verify", "-q", "HEAD");
  if (!head.ok) return { head: null, previous: null };
  const previous = await git("rev-parse", "--verify", "-q", "HEAD~1");
  return { head: head.out, previous: previous.ok ? previous.out : null };
}

/** Largest file mirrored (CBM has its own cap; this keeps the copy small). */
export const SHADOW_MAX_BYTES = 1_000_000;

/** A stable directory name for a repository: its base name plus a short hash of its absolute path. */
export function shadowId(repoDir: string): string {
  const norm = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = (norm.slice(norm.lastIndexOf("/") + 1) || "repo").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `${base}-${createHash("sha256").update(norm.toLowerCase()).digest("hex").slice(0, 8)}`;
}

export const shadowDirOf = (workDir: string, repoDir: string): string => `${workDir.replace(/\\/g, "/").replace(/\/+$/, "")}/shadow/${shadowId(repoDir)}`;
export const manifestPathOf = (workDir: string, repoDir: string): string => `${workDir.replace(/\\/g, "/").replace(/\/+$/, "")}/manifests/${shadowId(repoDir)}.json`;

/** True iff `path` is mirrored into the shadow. Pure. */
export function shadowIncludes(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === ".gitignore" || base === ".cbmignore") return false;
  if (isSecretPath(path)) return false;
  return isSpecArtifact(path) || isIndexable(path);
}

async function readManifest(path: string): Promise<ShadowManifest | null> {
  try {
    const m = JSON.parse(await readFile(path, "utf8")) as ShadowManifest;
    return m.version === 1 ? m : null;
  } catch {
    return null;
  }
}

async function looksBinary(abs: string): Promise<boolean> {
  try {
    const buf = (await readFile(abs)).subarray(0, 8192);
    return buf.includes(0);
  } catch {
    return true;
  }
}

async function pruneEmptyDirs(root: string, rel: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(`${root}/${rel}`, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!(await pruneEmptyDirs(root, rel === "" ? e.name : `${rel}/${e.name}`))) empty = false;
    } else empty = false;
  }
  if (empty && rel !== "") {
    await rm(`${root}/${rel}`, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
  return empty;
}

/** Options of {@link syncShadow}. */
export interface SyncOptions {
  readonly listFiles?: (repoDir: string) => Promise<string[]>;
  readonly maxBytes?: number;
  /** Test seam for the git calls. */
  readonly spawn?: typeof runProcess;
}

/** Brings the shadow in line with the repository (copy changed, remove vanished) and rewrites the manifest. */
export async function syncShadow(repoDir: string, workDir: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const shadowDir = shadowDirOf(workDir, repoDir);
  const manifestPath = manifestPathOf(workDir, repoDir);
  await mkdir(shadowDir, { recursive: true });
  await mkdir(manifestPath.slice(0, manifestPath.lastIndexOf("/")), { recursive: true });
  const old = (await readManifest(manifestPath))?.files ?? {};
  const listed = await (opts.listFiles ?? ((d) => listCandidateFiles(d)))(repoDir);
  const wanted = [...new Set([...listed, ...(await listSpecArtifacts(repoDir))])].filter(shadowIncludes).sort();
  const max = opts.maxBytes ?? SHADOW_MAX_BYTES;

  const files: Record<string, ShadowFile> = {};
  const changedPaths: string[] = [];
  let copied = 0;
  let unchanged = 0;
  for (const rel of wanted) {
    const abs = `${repoDir}/${rel}`;
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > max) continue;
    const prev = old[rel];
    if (prev !== undefined && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      files[rel] = prev;
      unchanged += 1;
      continue;
    }
    if (await looksBinary(abs)) continue;
    const sha256 = await sha256File(abs);
    files[rel] = { sha256, size: st.size, mtimeMs: st.mtimeMs };
    if (prev !== undefined && prev.sha256 === sha256) {
      unchanged += 1;
      continue;
    }
    await mkdir(`${shadowDir}/${rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""}`, { recursive: true });
    await copyFile(abs, `${shadowDir}/${rel}`);
    copied += 1;
    changedPaths.push(rel);
  }
  let removed = 0;
  for (const rel of Object.keys(old)) {
    if (files[rel] === undefined) {
      await rm(`${shadowDir}/${rel}`, { force: true }).catch(() => undefined);
      removed += 1;
      changedPaths.push(rel);
    }
  }
  if (removed > 0) await pruneEmptyDirs(shadowDir, "");
  const manifest: ShadowManifest = { version: 1, repoDir, files, syncedAt: new Date().toISOString() };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const snapshot = await snapshotShadow(shadowDir, opts.spawn);
  return { shadowDir, copied, removed, unchanged, files: Object.keys(files).length, changedPaths, manifest, snapshot };
}

/** Which of `paths` no longer match the manifest (changed, deleted, or never mirrored)? Reads the LIVE files. */
export async function staleAgainstManifest(repoDir: string, manifest: ShadowManifest, paths: readonly string[]): Promise<string[]> {
  const stale: string[] = [];
  for (const rel of paths) {
    const m = manifest.files[rel];
    if (m === undefined) {
      stale.push(rel);
      continue;
    }
    try {
      const st = await stat(`${repoDir}/${rel}`);
      if (st.size === m.size && st.mtimeMs === m.mtimeMs) continue;
      if ((await sha256File(`${repoDir}/${rel}`)) !== m.sha256) stale.push(rel);
    } catch {
      stale.push(rel);
    }
  }
  return stale;
}

export { readManifest };
