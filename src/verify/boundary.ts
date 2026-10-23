// Implements PHASE_1_SPEC.md §6.8 -- §5.1 [DET]
//
// `scanBoundary()` executes the B1-B8 rules (`src/verify/boundary-rules.ts`) over `src/**` and
// `package.json`. This is the mechanised enforcement of the PROJECT HARD BOUNDARY (PRD §5.1): a
// static scanner, not review judgment.

import { readFile, readdir } from "node:fs/promises";
import { toRepoRelPosix } from "../util/paths.ts";
import type { BoundaryRule } from "./boundary-rules.ts";
import { BOUNDARY_RULES } from "./boundary-rules.ts";

/** A single boundary-rule hit. */
export interface BoundaryViolation {
  readonly rule: BoundaryRule["id"];
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
}

/**
 * The single directory exempt from B3/B4 (and held to B9 instead): OSA's free-public-API research clients
 * (OSA_DIRECTIVE.md WS3.3/3.4, docs/osa/CONFLICTS.md C-01). A path *prefix*, declared once, so the exemption
 * is one greppable fact and cannot silently widen to a sibling directory.
 */
export const NETWORK_EXEMPT_PREFIX = "src/research/net/";

/** The one sanctioned child-process wrapper: exempt from B10/B11 (it is the thing those rules funnel everything into). */
export const EXEC_WRAPPER_PATH = "src/util/exec.ts";

/** The one file excluded by name (it contains every forbidden pattern by construction). */
const EXCLUDED_EXACT_REPO_REL_PATH = "src/verify/boundary-rules.ts";

/**
 * B2's closed runtime-dependency allowlist. `zod` was the only member through Phase 7;
 * `@modelcontextprotocol/sdk` is the operator's own explicitly confirmed, one-time exception added
 * for the MCP server feature (Phase 8, PRD §5.1). Declared once, by name, so the allowlist is
 * legible as a single, named, greppable fact rather than inline in the conditional below --
 * PHASE_8_SPEC.md §1.3, §7 FM-M3.
 */
const ALLOWED_DEPENDENCY_KEYS = ["zod", "@modelcontextprotocol/sdk"] as const;

async function listTsFilesRecursive(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursive(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Repo-relative paths of every `src/**\/*.ts` file `scanBoundary` actually evaluates, after the
 * two mandatory exclusions (`*.test.ts` and `boundary-rules.ts` itself). Exported so `doctor.ts`
 * can report `filesScanned` (PHASE_1_SPEC.md §4.2) without re-implementing the same walk.
 */
export async function listScannedSourceFiles(repoRoot: string): Promise<readonly string[]> {
  const absPaths = await listTsFilesRecursive(`${repoRoot}/src`);
  const kept: string[] = [];
  for (const absPath of absPaths) {
    const repoRelPath = toRepoRelPosix(repoRoot, absPath);
    if (repoRelPath.endsWith(".test.ts")) {
      continue;
    }
    if (repoRelPath === EXCLUDED_EXACT_REPO_REL_PATH) {
      continue;
    }
    kept.push(repoRelPath);
  }
  return kept;
}

/**
 * Removes a trailing `//`-style line comment, tracking single/double/backtick string state so a
 * `//` inside a string literal (notably a quoted network-URL scheme, e.g. `http` + `s://...`) is
 * never mistaken for a comment start. Used only for rule B4 -- a documentation URL in a real
 * comment is not a violation.
 */
function stripLineComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

async function scanSourceFile(absPath: string, repoRelPath: string): Promise<readonly BoundaryViolation[]> {
  const content = await readFile(absPath, "utf8");
  const lines = content.split(/\r\n|\r|\n/);
  const violations: BoundaryViolation[] = [];

  for (const rule of BOUNDARY_RULES) {
    if (rule.kind !== "source-pattern" || rule.pattern === undefined) {
      continue;
    }
    // B7's exclusion: a concrete model name/tier alias is legitimate inside src/adapters/**
    // (Phase 2+); this exclusion is written now even though src/adapters/ does not exist in
    // Phase 1, so the scanner does not need to change when it is added.
    if (rule.id === "B7" && repoRelPath.startsWith("src/adapters/")) {
      continue;
    }
    // The network exemption: B3/B4 do not apply under NETWORK_EXEMPT_PREFIX, and B9 applies *only* there.
    const inNetworkExemptDir = repoRelPath.startsWith(NETWORK_EXEMPT_PREFIX);
    if ((rule.id === "B3" || rule.id === "B4") && inNetworkExemptDir) {
      continue;
    }
    if (rule.id === "B9" && !inNetworkExemptDir) {
      continue;
    }
    if ((rule.id === "B10" || rule.id === "B11") && repoRelPath === EXEC_WRAPPER_PATH) {
      continue;
    }
    const pattern = rule.pattern;
    lines.forEach((rawLine, index) => {
      const testLine = rule.id === "B4" || rule.id === "B10" || rule.id === "B11" || rule.id === "B12" ? stripLineComment(rawLine) : rawLine;
      if (pattern.test(testLine)) {
        violations.push({ rule: rule.id, file: repoRelPath, line: index + 1, excerpt: rawLine });
      }
    });
  }

  return violations;
}

async function scanManifest(repoRoot: string): Promise<readonly BoundaryViolation[]> {
  let raw: string;
  try {
    raw = await readFile(`${repoRoot}/package.json`, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const deps: unknown = (parsed as Record<string, unknown>)["dependencies"];
  if (typeof deps !== "object" || deps === null) {
    return [];
  }
  const violations: BoundaryViolation[] = [];
  for (const key of Object.keys(deps as Record<string, unknown>)) {
    if (!ALLOWED_DEPENDENCY_KEYS.includes(key as (typeof ALLOWED_DEPENDENCY_KEYS)[number])) {
      violations.push({ rule: "B2", file: "package.json", line: 1, excerpt: key });
    }
  }
  return violations;
}

/**
 * Scans `src/**\/*.ts` (minus the two mandatory exclusions) and `package.json` against every rule
 * in {@link BOUNDARY_RULES}. Returns every violation found -- never stops at the first.
 */
export async function scanBoundary(repoRoot: string): Promise<readonly BoundaryViolation[]> {
  const files = await listScannedSourceFiles(repoRoot);
  const violations: BoundaryViolation[] = [];
  for (const repoRelPath of files) {
    violations.push(...(await scanSourceFile(`${repoRoot}/${repoRelPath}`, repoRelPath)));
  }
  violations.push(...(await scanManifest(repoRoot)));
  return violations;
}
