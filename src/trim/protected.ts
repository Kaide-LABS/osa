// Lines no trimmer may drop (OSA_DIRECTIVE.md WS4.3): file paths, hashes, error messages, test names -- plus
// OSA's own load-bearing lines: URLs (documentation sources), markdown headings (document structure) and the
// `[uncertain]` / cross-check status markers. These are deliberately generous: protecting too much costs a
// little compression, protecting too little costs correctness. They are engine-independent, so the guarantee
// holds for trim-1 and for any engine swapped in later.

const HASH = /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/i;
const URL = /https?:\/\/\S+/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const MARKERS = /\[(?:uncertain|unsupported|contradicted|unverifiable)\]/i;
const ERROR = /\b(?:error|errors|exception|failed|failure|fatal|panic|traceback|assertion)\b/i;
// A relative or absolute path with at least one separator and a file extension (src/osa/lock.ts, C:\x\y.json).
const PATH = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,8}\b/;
// node:test / TAP / jest-style result lines and test declarations.
const TEST = /^\s*(?:✔|✖|ok\b|not ok\b|PASS\b|FAIL\b)|\b(?:test|it|describe)\s*\(/;

/** True iff `line` must survive every trimmer byte-identical. Pure. */
export function isProtectedLine(line: string, keep: readonly string[] = []): boolean {
  if (keep.some((k) => k !== "" && line.includes(k))) return true;
  return HASH.test(line) || URL.test(line) || HEADING.test(line) || MARKERS.test(line) || ERROR.test(line) || PATH.test(line) || TEST.test(line);
}
