// On-disk format of the codebase index: two flat files under `<repo>/.osa/index/` -- portable on Windows / macOS /
// Linux, no database, no native extension. The directory carries its own `.gitignore` (`*`), so the index can never be
// committed and, crucially, can never be swept into an agent turn's fallback commit as an untracked file.
//
//   meta.json    { version, embedder, files: { <path>: { sha256, size, mtimeMs, chunks } } }
//   chunks.jsonl one chunk per line: { p, s, e, sym, k, snip, v: [[bucket, weight], ...] }

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { z } from "zod";

export const INDEX_VERSION = 1;

/** Repo-relative directory of the index. */
export const INDEX_DIR_REL = ".osa/index";

export const FileMetaSchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0), mtimeMs: z.number(), chunks: z.number().int().min(0) });
export type FileMeta = z.infer<typeof FileMetaSchema>;

export const IndexMetaSchema = z.strictObject({
  version: z.literal(INDEX_VERSION),
  embedder: z.string().min(1),
  updated_at: z.string().min(1),
  files: z.record(z.string(), FileMetaSchema),
});
export type IndexMeta = z.infer<typeof IndexMetaSchema>;

/** One stored chunk. */
export const StoredChunkSchema = z.strictObject({
  p: z.string(),
  s: z.number().int().min(1),
  e: z.number().int().min(1),
  sym: z.string().nullable(),
  k: z.enum(["symbol", "preamble", "window"]),
  snip: z.string(),
  v: z.array(z.tuple([z.number().int().min(0), z.number()])),
});
export type StoredChunk = z.infer<typeof StoredChunkSchema>;

export function indexDir(repoDir: string): string {
  return `${repoDir}/${INDEX_DIR_REL}`;
}

/** The loaded index: metadata plus the raw JSON line of every chunk, grouped by file (so unchanged files are never re-parsed or re-serialised). */
export interface RawIndex {
  readonly meta: IndexMeta | null;
  readonly linesByPath: Map<string, string[]>;
}

/** Reads the index; any problem (missing, corrupt, wrong version) yields an empty one, i.e. a full rebuild. */
export async function readRawIndex(repoDir: string): Promise<RawIndex> {
  const dir = indexDir(repoDir);
  try {
    const meta = IndexMetaSchema.parse(JSON.parse(await readFile(`${dir}/meta.json`, "utf8")));
    const linesByPath = new Map<string, string[]>();
    const text = await readFile(`${dir}/chunks.jsonl`, "utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const p = (JSON.parse(line) as { p?: unknown }).p;
      if (typeof p !== "string") throw new Error("chunk line without a path");
      const arr = linesByPath.get(p) ?? [];
      arr.push(line);
      linesByPath.set(p, arr);
    }
    return { meta, linesByPath };
  } catch {
    return { meta: null, linesByPath: new Map() };
  }
}

/**
 * Renames `from` onto `to`, retrying a few times when Windows says the target is momentarily in use (EPERM, EBUSY or EACCES: another process --
 * the MCP server, the CLI, a virus scanner -- has the old file open). Found by two eval processes updating one index at once, which crashed
 * with EPERM on the rename. Gives up after ~1.5 s and throws the last error. The sleep and the rename are injectable for the test.
 */
export async function renameWithRetry(from: string, to: string, deps: { readonly rename?: typeof rename; readonly sleep?: (ms: number) => Promise<void>; readonly attempts?: number } = {}): Promise<void> {
  const doRename = deps.rename ?? rename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 10;
  for (let i = 1; ; i++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(25 * i);
    }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await renameWithRetry(tmp, path);
}

/** Bumped by every {@link writeIndex} in this process, so a cache keyed by {@link indexStamp} can never miss an update made here. */
const generations = new Map<string, number>();
const genKey = (repoDir: string): string => repoDir.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();

/** Writes the whole index (chunks first, then meta, each atomically) and its `.gitignore`. */
export async function writeIndex(repoDir: string, meta: IndexMeta, linesByPath: ReadonlyMap<string, readonly string[]>): Promise<void> {
  const dir = indexDir(repoDir);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/.gitignore`, "# OSA code index -- derived data, never committed.\n*\n", "utf8");
  const lines: string[] = [];
  for (const p of [...linesByPath.keys()].sort()) lines.push(...(linesByPath.get(p) ?? []));
  await atomicWrite(`${dir}/chunks.jsonl`, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  await atomicWrite(`${dir}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
  generations.set(genKey(repoDir), (generations.get(genKey(repoDir)) ?? 0) + 1);
}

/**
 * A cache key for the two index files: mtime AND size of each, plus this process's write counter. mtime alone is not enough -- two updates in
 * one filesystem timestamp tick (~16 ms on Windows) share an mtime, and the cache then served the previous index (a stale read).
 */
export async function indexStamp(repoDir: string): Promise<string> {
  const dir = indexDir(repoDir);
  const m = async (f: string): Promise<string> => {
    try {
      const st = await stat(`${dir}/${f}`);
      return `${String(st.mtimeMs)}/${String(st.size)}`;
    } catch {
      return "-1";
    }
  };
  return `${await m("meta.json")}:${await m("chunks.jsonl")}:g${String(generations.get(genKey(repoDir)) ?? 0)}`;
}
