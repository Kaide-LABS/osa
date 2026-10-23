// Which files the code index MUST cover (the spec discipline's own artifacts) and which it must NEVER cover (secrets). Shared by the
// lexical index and by the codebase-memory-mcp shadow tree, so both engines have identical coverage rules (Suite 7c).
//
// Why a list instead of "whatever git tracks": the artifacts OSA and the loopr harness write live in places `.gitignore` and the built-in
// skip lists hide (`.osa/`, `.osa/`, `runs/`, root PHASE_N_SPEC.md files). The prior CBM spike found these silently missing from the
// index -- the files the whole discipline depends on were the ones an agent could not search. The paths here are the ones the code actually
// writes: runDirRel / specDirRel / step14DirRel / researchDirRel (src/osa, src/research), prdLockRecordPath and eventsPath (src/osa),
// handoffPath and driverLogPath (src/util/paths.ts), MEMORY_DIR_REL (src/memory/store.ts).

import { readdir, stat } from "node:fs/promises";

/** Directories walked in full for spec artifacts (repo-relative, POSIX). */
export const SPEC_ARTIFACT_ROOTS: readonly string[] = ["runs", ".osa/runs", ".osa/memory", "docs/osa"];

/** Extensions a spec artifact may have (jsonl: event and driver logs; yaml: research outline/fields). */
const SPEC_EXTENSIONS = new Set(["md", "json", "jsonl", "yaml", "yml", "txt"]);

/** Root-level files of the loopr/OSA discipline. */
const ROOT_SPEC_FILES = /^(?:PHASE_\d+_SPEC|COMPREHENSION|BUILD_COMPLETE|CONTEXT|CONTRACT|[A-Za-z0-9_-]*PRD[A-Za-z0-9_-]*)\.md$/;

/** Raw transcripts and index storage are inside those roots but are NOT spec artifacts. */
const NOT_SPEC = [".osa/chat-log/", ".osa/index/", ".osa/run.lock"];

const extOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** True iff `path` (repo-relative, POSIX) is an artifact of the spec discipline. Pure. */
export function isSpecArtifact(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (NOT_SPEC.some((n) => p.startsWith(n) || p.includes(`/${n}`))) return false;
  if (!p.includes("/")) return ROOT_SPEC_FILES.test(p);
  if (!SPEC_EXTENSIONS.has(extOf(p))) return false;
  return SPEC_ARTIFACT_ROOTS.some((r) => p.startsWith(`${r}/`));
}

const SECRET_BASENAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.dockercfg|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\.(?:json|ya?ml|toml|txt|ini|cfg|conf|csv|xml|env|properties))?|secrets?(?:\.(?:json|ya?ml|toml|txt|ini|cfg|conf|csv|xml|env|properties))?|.*service[-_]?account.*\.json|terraform\.tfstate(?:\.backup)?|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk|gpg|asc))$/i;
const SECRET_DIRS = [".ssh/", ".aws/", ".gnupg/", ".kube/", ".azure/", ".docker/"];

/** True iff `path` must never be indexed, whatever directory it is in. Pure; deliberately generous (a missed file costs a search, a leaked key costs a rotation). */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (SECRET_BASENAMES.test(base)) return true;
  return SECRET_DIRS.some((d) => p.startsWith(d) || p.includes(`/${d}`));
}

async function walk(repoDir: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(`${repoDir}/${rel}`, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(repoDir, p, out);
    else if (e.isFile() && isSpecArtifact(p) && !isSecretPath(p)) out.push(p);
  }
}

/** Every spec artifact on disk (gitignored or not), without secrets or transcripts. Sorted. */
export async function listSpecArtifacts(repoDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const root of SPEC_ARTIFACT_ROOTS) await walk(repoDir, root, out);
  try {
    for (const e of await readdir(repoDir, { withFileTypes: true })) {
      if (e.isFile() && ROOT_SPEC_FILES.test(e.name)) out.push(e.name);
    }
  } catch {
    /* unreadable repo root: nothing to add */
  }
  const kept: string[] = [];
  for (const p of out) {
    try {
      if ((await stat(`${repoDir}/${p}`)).isFile()) kept.push(p);
    } catch {
      /* vanished */
    }
  }
  return [...new Set(kept)].sort();
}
