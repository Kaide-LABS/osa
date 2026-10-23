// Tokenisation and the local "embedding" for the semantic codebase index (OSA_DIRECTIVE.md WS7).
//
// HONEST DESCRIPTION: this is NOT a neural embedding. The project may add no dependency and make no network
// call, so the default embedder is a sparse, hashed, sub-word TF-IDF vector with a small built-in concept table
// that expands QUERY words ("sign in" also looks for login/authenticate/session...). It is semantic only in the
// sense that identifiers are split into words (`parseArgs` -> parse, args), light-stemmed, and related concepts are
// linked; it finds "where do we count words" without the literal string `count_words`. The `Embedder` interface
// is the seam for a real embedding model later (`index.embedder` in the config).

/** Hash-space size. Sparse vectors, so a large space keeps collisions negligible. */
export const HASH_DIM = 1 << 16;

/** Tokens that carry no meaning in code. */
const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out", "has", "have", "this", "that", "with", "from", "into",
  "const", "let", "var", "function", "return", "if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "import", "export", "default", "from", "as",
  "class", "new", "this", "self", "true", "false", "null", "none", "undefined", "async", "await", "def", "fn", "func", "public", "private", "protected", "static", "void",
  "int", "string", "number", "boolean", "bool", "type", "interface", "extends", "implements", "readonly", "try", "catch", "finally", "throw", "of", "in", "is", "or", "to", "an", "be",
]);

/** Concept groups: a query word in a group also searches the others (at reduced weight). */
const CONCEPTS: readonly (readonly string[])[] = [
  ["auth", "authenticate", "authentication", "login", "signin", "sign", "session", "token", "credential", "password"],
  ["delete", "remove", "destroy", "drop", "unlink", "erase"],
  ["create", "add", "insert", "make", "build", "generate"],
  ["fetch", "get", "request", "download", "retrieve", "load"],
  ["send", "post", "upload", "write", "emit", "publish", "dispatch"],
  ["error", "exception", "fail", "failure", "fault", "throw", "panic", "crash"],
  ["parse", "decode", "deserialize", "tokenize", "lex", "read"],
  ["serialize", "encode", "stringify", "format", "render", "print"],
  ["test", "spec", "assert", "expect", "verify", "check"],
  ["config", "configuration", "setting", "option", "env", "environment", "flag"],
  ["log", "logger", "logging", "trace", "debug", "audit"],
  ["cache", "memo", "memoize", "store"],
  ["count", "total", "sum", "tally", "number"],
  ["file", "path", "directory", "folder", "fs"],
  ["user", "account", "profile", "member"],
  ["db", "database", "sql", "query", "table", "schema", "connection", "pool"],
  ["retry", "backoff", "again", "resilient"],
  ["http", "request", "response", "endpoint", "api", "rest", "url"],
  ["arg", "argument", "args", "cli", "command", "flag", "option"],
  ["hash", "digest", "checksum", "sha"],
  ["word", "token", "term"],
  ["protect", "preserve", "keep", "survive", "retain", "guard", "safe", "never", "immutable"],
  ["trim", "prune", "shorten", "compress", "truncate", "cut"],
];

const CONCEPT_OF = new Map<string, number[]>();
CONCEPTS.forEach((group, gi) => {
  for (const w of group) CONCEPT_OF.set(w, [...(CONCEPT_OF.get(w) ?? []), gi]);
});

/** Light stemming: plural and common verb endings. Pure. */
export function stem(w: string): string {
  // "trimming" -> "trimm" -> "trim", "stopped" -> "stopp" -> "stop"; "ss"/"ll"/"ff"/"zz" are real endings and stay.
  const undouble = (x: string): string => (x.length > 3 && x[x.length - 1] === x[x.length - 2] && !"slfz".includes(x[x.length - 1] as string) ? x.slice(0, -1) : x);
  if (w.length > 5 && w.endsWith("ing")) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ied")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Splits text into lowercase sub-word tokens: camelCase, snake_case, kebab-case, digits; stop words dropped; stemmed. Pure. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** FNV-1a over UTF-16 code units, folded into {@link HASH_DIM}. Pure. */
export function hashToken(t: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % HASH_DIM;
}

/** A sparse vector: hash bucket -> weight. */
export type SparseVector = ReadonlyMap<number, number>;

/** Term-frequency vector (sublinear tf; unigrams at weight 1, adjacent bigrams at 0.5). Pure. */
export function termVector(text: string): Map<number, number> {
  const tokens = tokenize(text);
  const counts = new Map<number, number>();
  const bump = (key: string, w: number): void => {
    const h = hashToken(key);
    counts.set(h, (counts.get(h) ?? 0) + w);
  };
  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i] as string, 1);
    if (i + 1 < tokens.length) bump(`${tokens[i] as string}_${tokens[i + 1] as string}`, 0.5);
  }
  const v = new Map<number, number>();
  for (const [h, c] of counts) v.set(h, 1 + Math.log(c));
  return v;
}

/** The query's term vector plus concept expansion (related words at 0.4 weight). Pure. */
export function queryVector(query: string): Map<number, number> {
  const base = termVector(query);
  const seen = new Set(tokenize(query));
  for (const t of seen) {
    for (const gi of CONCEPT_OF.get(t) ?? CONCEPT_OF.get(stem(t)) ?? []) {
      for (const related of CONCEPTS[gi] as readonly string[]) {
        const rs = stem(related);
        if (seen.has(rs)) continue;
        const h = hashToken(rs);
        if (!base.has(h)) base.set(h, 0.4);
      }
    }
  }
  return base;
}

/** The embedding seam: text -> sparse vector. */
export interface Embedder {
  readonly id: string;
  /** Embed chunk text. */
  embedDocument(text: string): Map<number, number>;
  /** Embed a search query. */
  embedQuery(text: string): Map<number, number>;
}

/** The default, dependency-free embedder. */
export const LocalHashEmbedder: Embedder = {
  id: "local-hash-tfidf-v1",
  embedDocument: termVector,
  embedQuery: queryVector,
};
