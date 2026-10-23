import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { MemoryEventSink } from "../osa/events.ts";
import { tempGitRepo } from "../osa/fixtures.test.ts";
import { MAX_CHUNK_LINES, chunkFile, extensionOf } from "./chunker.ts";
import { isIndexable, updateIndex } from "./indexer.ts";
import { clearSearchCache, renderIndexContext, searchIndex } from "./search.ts";
import { LocalHashEmbedder, hashToken, queryVector, stem, termVector, tokenize } from "./tokenize.ts";
import type { Embedder } from "./tokenize.ts";

const FILES: Record<string, string> = {
  "src/auth/login.ts": `import { createHash } from "node:crypto";

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export async function authenticateUser(email: string, password: string): Promise<Session | null> {
  const user = await findUserByEmail(email);
  if (user === null) return null;
  if (user.passwordHash !== hashPassword(password)) return null;
  return createSession(user.id);
}

export function createSession(userId: string): Session {
  return { token: randomToken(), userId, expiresAt: Date.now() + 3600_000 };
}

export function verifySessionToken(token: string): boolean {
  return sessions.has(token);
}
`,
  "src/db/pool.ts": `export class ConnectionPool {
  private idle: Connection[] = [];
  constructor(private readonly max: number, private readonly connect: () => Promise<Connection>) {}

  async acquire(): Promise<Connection> {
    const existing = this.idle.pop();
    if (existing !== undefined) return existing;
    return this.connect();
  }

  release(conn: Connection): void {
    if (this.idle.length < this.max) this.idle.push(conn);
    else conn.close();
  }
}

export function createPool(max: number): ConnectionPool {
  return new ConnectionPool(max, openDatabaseConnection);
}
`,
  "src/http/client.ts": `export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let delay = 200;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // network error: fall through to the backoff
    }
    await sleep(delay);
    delay *= 2; // exponential backoff
  }
  throw new Error("request failed after retries");
}
`,
  "src/cli/args.ts": `export interface Options { verbose: boolean; files: string[] }

export function parseArgs(argv: string[]): Options {
  const opts: Options = { verbose: false, files: [] };
  for (const a of argv) {
    if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a.startsWith("-")) throw new Error("unknown flag " + a);
    else opts.files.push(a);
  }
  return opts;
}
`,
  "src/text/wordcount.ts": `/** Counts the words in a piece of text. */
export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\\s+/).length;
}

export function countLines(text: string): number {
  return text === "" ? 0 : text.split("\\n").length;
}
`,
  "test/wordcount.test.ts": `import { countWords } from "../src/text/wordcount.ts";
test("counts words", () => { assert(countWords("a b c") === 3); });
`,
  "src/log/logger.ts": `import { appendFileSync } from "node:fs";

export class Logger {
  constructor(private readonly path: string) {}
  info(message: string): void { this.writeToFile("INFO", message); }
  warn(message: string): void { this.writeToFile("WARN", message); }
  error(message: string): void { this.writeToFile("ERROR", message); }
  private writeToFile(level: string, message: string): void {
    appendFileSync(this.path, new Date().toISOString() + " " + level + " " + message + "\\n");
  }
}
`,
  "src/cache/lru.ts": `export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K; // evict the least recently used entry
      this.map.delete(oldest);
    }
  }
}
`,
  "src/files/reader.py": `import os

def read_text_file(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()

def list_directory(folder):
    return sorted(os.listdir(folder))
`,
  "billing/invoice.go": `package billing

type Item struct {
	Price float64
	Qty   int
}

func ApplyDiscount(total float64, percent float64) float64 {
	return total * (1 - percent/100)
}

func CalculateInvoiceTotal(items []Item, discountPercent float64) float64 {
	sum := 0.0
	for _, it := range items {
		sum += it.Price * float64(it.Qty)
	}
	return ApplyDiscount(sum, discountPercent)
}
`,
  "docs/README.md": `# Project

Overview of the project.

## Installation

Run npm install and then npm start.

## Configuration

Set the environment variables listed below to configure the application.

## Troubleshooting

If the server does not start, check the port is free.
`,
  "src/errors/handler.ts": `export class AppError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function formatErrorResponse(err: unknown): { status: number; body: string } {
  if (err instanceof AppError) return { status: err.status, body: err.message };
  return { status: 500, body: "internal error" };
}
`,
};

async function fixture(): Promise<string> {
  const repoDir = await tempGitRepo();
  for (const [p, content] of Object.entries(FILES)) {
    await mkdir(`${repoDir}/${p.slice(0, p.lastIndexOf("/"))}`, { recursive: true });
    await writeFile(`${repoDir}/${p}`, content, "utf8");
  }
  return repoDir;
}

/** The fixture files plus the README.md that `tempGitRepo` commits. */
const FILE_COUNT = Object.keys(FILES).length + 1;

const QUERIES: readonly [string, string][] = [
  ["where do we check the user's password when signing in", "src/auth/login.ts"],
  ["count the number of words in some text", "src/text/wordcount.ts"],
  ["retry a failed web request with exponential backoff", "src/http/client.ts"],
  ["parse command line flags", "src/cli/args.ts"],
  ["reuse database connections instead of opening new ones", "src/db/pool.ts"],
  ["write log messages to disk", "src/log/logger.ts"],
  ["evict the least recently used entries", "src/cache/lru.ts"],
  ["read a text file from a folder", "src/files/reader.py"],
  ["compute the invoice total with a discount", "billing/invoice.go"],
  ["format an error response for the client", "src/errors/handler.ts"],
  ["how do I install the project", "docs/README.md"],
];

test("known queries put the relevant file in the top 3 hits (WS7 acceptance), including ones with no literal overlap", async () => {
  const repoDir = await fixture();
  await updateIndex({ repoDir });
  const misses: string[] = [];
  for (const [query, expected] of QUERIES) {
    const hits = await searchIndex(repoDir, query, { k: 3 });
    if (!hits.some((h) => h.path === expected)) misses.push(`${query} -> ${hits.map((h) => h.path).join(", ")} (wanted ${expected})`);
  }
  assert.deepEqual(misses, []);
});

test("a hit carries a path, a line range, the symbol and a snippet", async () => {
  const repoDir = await fixture();
  await updateIndex({ repoDir });
  const [top] = await searchIndex(repoDir, "authenticate a user with an email and password", { k: 1 });
  assert.equal(top?.path, "src/auth/login.ts");
  assert.equal(top?.symbol, "authenticateUser");
  assert.ok((top?.startLine ?? 0) >= 1 && (top?.endLine ?? 0) >= (top?.startLine ?? 99));
  assert.match(top?.snippet ?? "", /findUserByEmail/);
  assert.match(renderIndexContext([top!]), /^## Where to look first[\s\S]*`src\/auth\/login\.ts:\d+-\d+` \(authenticateUser\)/);
  assert.equal(renderIndexContext([]), "");
});

test("incremental: an unchanged second update re-chunks nothing; editing one file touches only that file; delete and add are tracked (uses file hashing)", async () => {
  const repoDir = await fixture();
  const events = new MemoryEventSink();
  const first = await updateIndex({ repoDir, events });
  assert.equal(first.added, FILE_COUNT);
  assert.equal(first.rebuiltAll, true);
  assert.ok(first.chunks > first.files, "files are split into several chunks");

  const second = await updateIndex({ repoDir, events });
  assert.deepEqual([second.added, second.changed, second.removed, second.unchanged], [0, 0, 0, FILE_COUNT]);

  await writeFile(`${repoDir}/src/text/wordcount.ts`, `${FILES["src/text/wordcount.ts"]}\nexport function countCharacters(text: string): number { return text.length; }\n`, "utf8");
  await mkdir(`${repoDir}/src/new`, { recursive: true });
  await writeFile(`${repoDir}/src/new/feature.ts`, "export function brandNewFeature(): string { return 'new'; }\n", "utf8");
  await rm(`${repoDir}/src/cache/lru.ts`);
  const third = await updateIndex({ repoDir, events });
  assert.deepEqual([third.added, third.changed, third.removed], [1, 1, 1]);

  clearSearchCache();
  assert.equal((await searchIndex(repoDir, "count the characters in a string", { k: 1 }))[0]?.symbol, "countCharacters");
  assert.equal((await searchIndex(repoDir, "brand new feature", { k: 1 }))[0]?.path, "src/new/feature.ts");
  assert.ok(!(await searchIndex(repoDir, "evict least recently used", { k: 10 })).some((h) => h.path === "src/cache/lru.ts"), "deleted file is gone from the index");
  assert.equal(events.events.filter((e) => e.event === "index_updated").length, 3);
});

test("a touched-but-identical file is not re-chunked (the hash decides, mtime is only the fast path)", async () => {
  const repoDir = await fixture();
  await updateIndex({ repoDir });
  const later = new Date(Date.now() + 60_000);
  await utimes(`${repoDir}/src/cli/args.ts`, later, later);
  const r = await updateIndex({ repoDir });
  assert.deepEqual([r.added, r.changed, r.unchanged], [0, 0, FILE_COUNT]);
});

test("the index lives in .osa/index with its own .gitignore, so it can never be committed or swept into an agent commit", async () => {
  const repoDir = await fixture();
  await updateIndex({ repoDir });
  assert.match(await readFile(`${repoDir}/.osa/index/.gitignore`, "utf8"), /^\*$/m);
  assert.ok((await stat(`${repoDir}/.osa/index/meta.json`)).isFile());
  assert.ok((await stat(`${repoDir}/.osa/index/chunks.jsonl`)).isFile());
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".osa"], { cwd: repoDir }).toString().trim(), "", "git sees nothing to commit in .osa/index");
  const second = await updateIndex({ repoDir });
  assert.ok(!second.rebuiltAll);
});

test("excluded and unindexable files stay out: node_modules, dist, lockfiles, binaries, oversized files, the index itself", async () => {
  const repoDir = await fixture();
  await mkdir(`${repoDir}/node_modules/dep`, { recursive: true });
  await writeFile(`${repoDir}/node_modules/dep/index.js`, "export function vendored() {}\n");
  await mkdir(`${repoDir}/dist`, { recursive: true });
  await writeFile(`${repoDir}/dist/out.js`, "function built() {}\n");
  await writeFile(`${repoDir}/package-lock.json`, "{}\n");
  await writeFile(`${repoDir}/blob.ts`, "const x = 1;\0\0binary\n");
  await writeFile(`${repoDir}/huge.ts`, `export function hugeOne() {}\n${"// pad\n".repeat(80_000)}`);
  const r = await updateIndex({ repoDir, maxFileBytes: 100_000 });
  assert.equal(r.files, FILE_COUNT);
  const all = await searchIndex(repoDir, "vendored built huge binary", { k: 50 });
  assert.ok(!all.some((h) => /node_modules|dist\/|blob\.ts|huge\.ts|package-lock/.test(h.path)));
  assert.equal(isIndexable("src/a.ts"), true);
  assert.equal(isIndexable("a/node_modules/b.js"), false);
  assert.equal(isIndexable("x.min.js"), false);
  assert.equal(isIndexable("image.png"), false);
});

test("a different embedder (or index version) forces a full rebuild; searching with no index returns nothing", async () => {
  const repoDir = await fixture();
  clearSearchCache();
  assert.deepEqual(await searchIndex(repoDir, "anything"), []);
  await updateIndex({ repoDir });
  const other: Embedder = { ...LocalHashEmbedder, id: "other-embedder" };
  const r = await updateIndex({ repoDir, embedder: other });
  assert.equal(r.rebuiltAll, true);
  assert.equal(r.added, FILE_COUNT);
});

test("a corrupt index is treated as no index: the next update rebuilds it", async () => {
  const repoDir = await fixture();
  await updateIndex({ repoDir });
  await writeFile(`${repoDir}/.osa/index/chunks.jsonl`, "{not json\n", "utf8");
  clearSearchCache();
  const r = await updateIndex({ repoDir });
  assert.equal(r.rebuiltAll, true);
  assert.ok((await searchIndex(repoDir, "parse command line flags", { k: 1 })).length === 1);
});

// ---- chunker ----

test("chunker: TypeScript is split at function/class/method boundaries, with the symbol name and exact line ranges", () => {
  const chunks = chunkFile("src/db/pool.ts", FILES["src/db/pool.ts"] as string);
  assert.deepEqual(chunks.map((c) => c.symbol), ["ConnectionPool", "acquire", "release", "createPool"]);
  const acquire = chunks.find((c) => c.symbol === "acquire");
  assert.match(acquire?.text ?? "", /idle\.pop/);
  assert.equal((FILES["src/db/pool.ts"] as string).split("\n")[(acquire?.startLine ?? 1) - 1]?.trim(), "async acquire(): Promise<Connection> {");
  assert.ok(chunks.every((c) => c.kind === "symbol"));
});

test("chunker: Python, Go and Markdown boundaries; a preamble chunk holds the imports", () => {
  assert.deepEqual(chunkFile("a.py", FILES["src/files/reader.py"] as string).map((c) => [c.symbol, c.kind]), [[null, "preamble"], ["read_text_file", "symbol"], ["list_directory", "symbol"]]);
  assert.deepEqual(chunkFile("b.go", FILES["billing/invoice.go"] as string).map((c) => c.symbol).filter((s) => s !== null), ["Item", "ApplyDiscount", "CalculateInvoiceTotal"]);
  assert.deepEqual(chunkFile("README.md", FILES["docs/README.md"] as string).map((c) => c.symbol), ["Project", "Installation", "Configuration", "Troubleshooting"]);
});

test("chunker: a long function is split into overlapping windows that keep the symbol; unknown extensions use plain windows", () => {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${String(i)} = ${String(i)};`).join("\n");
  const chunks = chunkFile("big.ts", `export function huge() {\n${body}\n}\n`);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.symbol === "huge" && c.text.split("\n").length <= MAX_CHUNK_LINES));
  assert.equal(chunks[0]?.kind, "symbol");
  assert.equal(chunks[1]?.kind, "window");
  assert.ok((chunks[1]?.startLine ?? 0) < (chunks[0]?.endLine ?? 0), "windows overlap");
  const plain = chunkFile("data.yaml", Array.from({ length: 130 }, (_, i) => `k${String(i)}: ${String(i)}`).join("\n"));
  assert.ok(plain.length >= 2 && plain.every((c) => c.symbol === null && c.kind === "window"));
  assert.deepEqual(chunkFile("empty.ts", "\n\n"), []);
  assert.equal(extensionOf("a/b/c.TSX"), "tsx");
  assert.equal(extensionOf("Makefile"), "");
});

test("chunker: code fences in Markdown do not create fake headings", () => {
  const md = "# Title\ntext\n```sh\n# not a heading\n```\n## Real\nmore\n";
  assert.deepEqual(chunkFile("x.md", md).map((c) => c.symbol), ["Title", "Real"]);
});

// ---- tokenizer / embedder ----

test("tokenizer splits identifiers into stemmed sub-words and drops code noise", () => {
  assert.deepEqual(tokenize("parseArgs"), ["parse", "arg"]);
  assert.deepEqual(tokenize("read_text_file"), ["read", "text", "file"]);
  assert.deepEqual(tokenize("HTTPServerError"), ["http", "server", "error"]);
  assert.deepEqual(tokenize("const x = return the"), []);
  assert.equal(stem("retries"), "retry");
  assert.equal(stem("counting"), "count");
  assert.equal(hashToken("abc"), hashToken("abc"));
});

test("query vectors expand concepts (sign in ~ login/authenticate) at reduced weight, and document vectors do not", () => {
  const q = queryVector("sign in");
  const d = termVector("sign in");
  assert.ok(q.size > d.size);
  assert.ok(q.has(LocalHashEmbedder.embedQuery("login").size > 0 ? [...queryVector("login").keys()][0] as number : -1));
  assert.equal(LocalHashEmbedder.embedDocument("x y").size, termVector("x y").size);
});
