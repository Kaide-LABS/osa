// Incremental (re)indexing driven by the project's existing file hashing (`sha256File`). The fast path is a
// size + mtime comparison; only a file whose size or mtime changed is hashed, and only a file whose HASH changed is
// re-chunked and re-embedded. Removed files drop out. An embedder or format change forces a full rebuild.

import { readFile, readdir, stat } from "node:fs/promises";
import type { EventSink } from "../osa/events.ts";
import { sha256File } from "../util/hash.ts";
import { runProcess } from "../util/exec.ts";
import { chunkFile, INDEXED_EXTENSIONS, extensionOf } from "./chunker.ts";
import { INDEX_VERSION, readRawIndex, writeIndex } from "./store.ts";
import type { FileMeta, IndexMeta, StoredChunk } from "./store.ts";
import { isSecretPath, isSpecArtifact, listSpecArtifacts } from "./spec-artifacts.ts";
import { LocalHashEmbedder } from "./tokenize.ts";
import type { Embedder } from "./tokenize.ts";

/** Largest file indexed (bytes). Bigger files are almost always generated or data. */
export const MAX_FILE_BYTES = 400_000;
const SNIPPET_CHARS = 600;

const EXCLUDED_DIRS = ["node_modules/", "dist/", "build/", "coverage/", "vendor/", "target/", ".next/", ".git/", ".osa/", ".venv/", "__pycache__/"];
const EXCLUDED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum"]);

/** True iff `path` (repo-relative, POSIX) should be indexed. Pure. */
export function isIndexable(path: string): boolean {
  if (EXCLUDED_DIRS.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (EXCLUDED_FILES.has(base) || base.endsWith(".min.js") || base.endsWith(".map")) return false;
  return INDEXED_EXTENSIONS.has(extensionOf(path));
}

/** Lists candidate files: tracked + untracked-but-not-ignored (git), else a directory walk. */
export async function listCandidateFiles(repoDir: string, spawn: typeof runProcess = runProcess): Promise<string[]> {
  const r = await spawn({ command: "git", args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd: repoDir, timeoutMs: 60_000 });
  if (r.exitCode === 0) return [...new Set(r.stdout.split("\0").filter((p) => p !== ""))].map((p) => p.replace(/\\/g, "/"));
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(`${repoDir}/${rel}`, { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.includes(`${e.name}/`)) await walk(p);
      } else out.push(p);
    }
  };
  await walk("");
  return out;
}

/** What an update did. */
export interface UpdateResult {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly files: number;
  readonly chunks: number;
  readonly rebuiltAll: boolean;
  readonly ms: number;
}

/** Options of {@link updateIndex}. */
export interface UpdateOptions {
  readonly repoDir: string;
  readonly embedder?: Embedder;
  readonly events?: EventSink;
  /** Test seam: replaces `git ls-files`. */
  readonly listFiles?: (repoDir: string) => Promise<string[]>;
  readonly maxFileBytes?: number;
}

function toStoredChunks(path: string, content: string, embedder: Embedder): string[] {
  return chunkFile(path, content).map((c) => {
    const vec = embedder.embedDocument(`${c.path}\n${c.symbol ?? ""}\n${c.text}`);
    const stored: StoredChunk = {
      p: c.path,
      s: c.startLine,
      e: c.endLine,
      sym: c.symbol,
      k: c.kind,
      snip: c.text.slice(0, SNIPPET_CHARS),
      v: [...vec].map(([b, w]): [number, number] => [b, Math.round(w * 1000) / 1000]),
    };
    return JSON.stringify(stored);
  });
}

/** Brings the index up to date with the working tree. Emits `index_updated`. Never throws for an unreadable single file. */
export async function updateIndex(opts: UpdateOptions): Promise<UpdateResult> {
  const t0 = Date.now();
  const embedder = opts.embedder ?? LocalHashEmbedder;
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const existing = await readRawIndex(opts.repoDir);
  const rebuildAll = existing.meta === null || existing.meta.version !== INDEX_VERSION || existing.meta.embedder !== embedder.id;
  const oldFiles: Record<string, FileMeta> = rebuildAll ? {} : (existing.meta as IndexMeta).files;
  const oldLines = rebuildAll ? new Map<string, string[]>() : existing.linesByPath;

  // Spec artifacts are ALWAYS candidates (gitignore and the built-in skip lists hide exactly the files the discipline depends on); secrets never are.
  const listed = await (opts.listFiles ?? ((d) => listCandidateFiles(d)))(opts.repoDir);
  const candidates = [...new Set([...listed.filter(isIndexable), ...(await listSpecArtifacts(opts.repoDir))])].filter((p) => !isSecretPath(p) && (isSpecArtifact(p) || isIndexable(p))).sort();
  const files: Record<string, FileMeta> = {};
  const lines = new Map<string, string[]>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let metaDirty = rebuildAll;

  for (const path of candidates) {
    const abs = `${opts.repoDir}/${path}`;
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > maxBytes) continue;
    const prev = oldFiles[path];
    if (prev !== undefined && prev.size === st.size && prev.mtimeMs === st.mtimeMs && oldLines.has(path)) {
      files[path] = prev;
      lines.set(path, oldLines.get(path) as string[]);
      unchanged += 1;
      continue;
    }
    let sha256: string;
    try {
      sha256 = await sha256File(abs);
    } catch {
      continue;
    }
    if (prev !== undefined && prev.sha256 === sha256 && oldLines.has(path)) {
      // Touched but identical: keep the chunks, remember the new mtime.
      files[path] = { ...prev, size: st.size, mtimeMs: st.mtimeMs };
      lines.set(path, oldLines.get(path) as string[]);
      unchanged += 1;
      metaDirty = true;
      continue;
    }
    const content = await readFile(abs, "utf8");
    if (content.includes("\0")) continue; // binary
    const chunkLines = toStoredChunks(path, content, embedder);
    files[path] = { sha256, size: st.size, mtimeMs: st.mtimeMs, chunks: chunkLines.length };
    lines.set(path, chunkLines);
    if (prev === undefined) added += 1;
    else changed += 1;
  }
  const removed = Object.keys(oldFiles).filter((p) => files[p] === undefined).length;

  if (rebuildAll || added > 0 || changed > 0 || removed > 0 || metaDirty) {
    await writeIndex(opts.repoDir, { version: INDEX_VERSION, embedder: embedder.id, updated_at: new Date().toISOString(), files }, lines);
  }
  const chunks = [...lines.values()].reduce((n, l) => n + l.length, 0);
  const result: UpdateResult = { added, changed, removed, unchanged, files: Object.keys(files).length, chunks, rebuiltAll: rebuildAll, ms: Date.now() - t0 };
  await opts.events?.emit("index_updated", { ...result });
  return result;
}
