// Chunking: split a source file into retrievable pieces, by SYMBOL (function / class / method / type / heading)
// where the language is recognised, else into overlapping line windows. Heuristic, regex-based and dependency-free
// by design (no tree-sitter): it errs on the side of a few more, smaller chunks rather than missing a boundary.

/** One retrievable piece of a file. Line numbers are 1-based and inclusive. */
export interface Chunk {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The symbol (function/class/heading) this chunk starts at, or `null` for preamble / plain windows. */
  readonly symbol: string | null;
  readonly kind: "symbol" | "preamble" | "window";
  readonly text: string;
}

/** Longest chunk, in lines, before it is split into windows. */
export const MAX_CHUNK_LINES = 80;
const WINDOW_LINES = 60;
const WINDOW_OVERLAP = 10;
const PREAMBLE_MAX_LINES = 40;

type SymbolFinder = (line: string) => string | null;

const first = (m: RegExpMatchArray | null, ...groups: number[]): string | null => {
  if (m === null) return null;
  for (const g of groups) if (m[g] !== undefined && m[g] !== "") return m[g];
  return null;
};

const FINDERS: Readonly<Record<string, SymbolFinder>> = {
  js: (l) =>
    first(l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/), 1) ??
    first(l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/), 1) ??
    first(l.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+(\w+)/), 1) ??
    first(l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/), 1) ??
    first(l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/), 1) ??
    first(l.match(/^\s{2,}(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/), 1),
  py: (l) => first(l.match(/^\s*(?:async\s+)?def\s+(\w+)/), 1) ?? first(l.match(/^\s*class\s+(\w+)/), 1),
  go: (l) => first(l.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/), 1) ?? first(l.match(/^type\s+(\w+)\s+(?:struct|interface)/), 1),
  rust: (l) => first(l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/), 1) ?? first(l.match(/^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/), 1),
  generic: (l) =>
    first(l.match(/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|suspend)\s+)*(?:class|interface|struct|enum|object|trait)\s+(\w+)/), 1) ??
    first(l.match(/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async)\s+)+[\w<>\[\],.?\s]+?\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w., ]+)?\s*\{?\s*$/), 1) ??
    first(l.match(/^\s*(?:def|fun|func|function|sub)\s+(\w+)/), 1),
  md: (l) => first(l.match(/^#{1,3}\s+(.+?)\s*#*\s*$/), 1),
};

const EXT_TO_FINDER: Readonly<Record<string, string>> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  py: "py", go: "go", rs: "rust",
  java: "generic", kt: "generic", kts: "generic", cs: "generic", swift: "generic", php: "generic", rb: "generic", scala: "generic", c: "generic", h: "generic", cpp: "generic", hpp: "generic", cc: "generic",
  md: "md", markdown: "md", mdx: "md",
};

/** File extensions worth indexing. */
export const INDEXED_EXTENSIONS: ReadonlySet<string> = new Set([...Object.keys(EXT_TO_FINDER), "json", "yaml", "yml", "toml", "sql", "sh", "css", "scss", "html", "txt", "xml"]);

/** The extension of `path`, lowercase, without the dot ("" if none). */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function windows(path: string, lines: readonly string[], startLine: number, symbol: string | null, kind: Chunk["kind"]): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += WINDOW_LINES - WINDOW_OVERLAP) {
    const slice = lines.slice(i, i + WINDOW_LINES);
    if (slice.join("").trim() === "") continue;
    out.push({ path, startLine: startLine + i, endLine: startLine + i + slice.length - 1, symbol, kind: kind === "symbol" && i > 0 ? "window" : kind, text: slice.join("\n") });
    if (i + WINDOW_LINES >= lines.length) break;
  }
  return out;
}

/** Chunks `content` (the file at repo-relative `path`). Pure. */
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
  if (lines.length === 0) return [];
  const finderName = EXT_TO_FINDER[extensionOf(path)];
  if (finderName === undefined) return windows(path, lines, 1, null, "window");
  const find = FINDERS[finderName] as SymbolFinder;

  // Boundaries: every line where a symbol starts. Markdown headings and code symbols alike.
  const starts: { line: number; symbol: string }[] = [];
  let inFence = false;
  lines.forEach((l, idx) => {
    if (finderName === "md" && /^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (inFence) return;
    const s = find(l);
    if (s !== null) starts.push({ line: idx, symbol: s });
  });
  if (starts.length === 0) return windows(path, lines, 1, null, "window");

  const chunks: Chunk[] = [];
  const preamble = lines.slice(0, starts[0]?.line ?? 0);
  if (preamble.join("").trim() !== "") {
    chunks.push({ path, startLine: 1, endLine: preamble.length, symbol: null, kind: "preamble", text: preamble.slice(0, PREAMBLE_MAX_LINES).join("\n") });
  }
  starts.forEach((s, i) => {
    const end = (starts[i + 1]?.line ?? lines.length) - 1;
    const body = lines.slice(s.line, end + 1);
    while (body.length > 1 && (body[body.length - 1] as string).trim() === "") body.pop();
    if (body.length <= MAX_CHUNK_LINES) {
      chunks.push({ path, startLine: s.line + 1, endLine: s.line + body.length, symbol: s.symbol, kind: "symbol", text: body.join("\n") });
    } else {
      chunks.push(...windows(path, body, s.line + 1, s.symbol, "symbol"));
    }
  });
  return chunks;
}
