// Turns an agent's ask into the pieces the engines need: single keywords for semantic search, identifier-shaped tokens for exact/symbol
// search, and the literal words an independent grep probe can look for. Pure.

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does done for from had has have how i if in into is it its of on or our should so than that the their then there these they this those to " +
    "us was we were what when where which who why will with would you your about after again all also any because before between both each few more most other over same some such too very " +
    "code file files function functions method methods class where find show tell make sure ensure actually before start work works used use using get gets set sets call calls called thing things way " +
    "implementation implemented implement happen happens look looks long wide need needs want wants anything something everything"
  ).split(/\s+/),
);

/** The pieces of a query. */
export interface QueryTerms {
  /** Identifier-shaped tokens as written (camelCase, snake_case, dotted, file names, UPPER_CASE, tokens with digits). */
  readonly identifiers: readonly string[];
  /** Lowercase content words (identifiers' sub-words included), stop words removed, duplicates removed, longest first. */
  readonly words: readonly string[];
  /** Words, split further at camelCase boundaries, lowercase (for symbol/path agreement). */
  readonly fragments: ReadonlySet<string>;
}

const IDENT = /^(?:[\w.-]+(?:\/[\w.-]+)+|[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+|[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+|[A-Z][A-Z0-9_]{2,}|[A-Za-z]+\d+[A-Za-z0-9]*)$/;

function splitCamel(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
}

/** Extracts the terms of `query`. */
export function queryTerms(query: string): QueryTerms {
  const raw = query.split(/[\s,;:!?()[\]{}"'`]+/).map((t) => t.replace(/^[.\-_/]+|[.\-_/]+$/g, "")).filter((t) => t !== "");
  const identifiers = [...new Set(raw.filter((t) => t.length >= 3 && IDENT.test(t)))];
  const words = new Map<string, number>();
  const fragments = new Set<string>();
  for (const t of raw) {
    for (const piece of splitCamel(t)) {
      const w = piece.toLowerCase();
      if (w.length < 2) continue;
      fragments.add(w);
      if (w.length >= 3 && !STOPWORDS.has(w)) words.set(w, Math.max(words.get(w) ?? 0, w.length));
    }
  }
  const ordered = [...words.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  return { identifiers, words: ordered, fragments };
}

/** A simple plural/-ing/-ed-tolerant comparison key. Pure. */
export function loose(w: string): string {
  let x = w.toLowerCase();
  if (x.length > 5 && x.endsWith("ing")) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith("ed")) x = x.slice(0, -2);
  else if (x.length > 4 && x.endsWith("es")) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith("s") && !x.endsWith("ss")) x = x.slice(0, -1);
  return x;
}
