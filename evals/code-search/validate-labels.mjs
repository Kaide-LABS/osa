#!/usr/bin/env node
// Dependency-free validator for the code-search label fixture (ESM, node: builtins only).
//
//   node validate-labels.mjs --root osa=<dir> --root hostel=<dir> --root hms=<dir> [--check-hashes] [--dump]
//
// Checks, for every query in queries.json:
//   * structure: unique id, known repo, known kind, non-empty query/answer/note, expect is a non-empty list
//     (cross-file queries need 2-4 expect locations), decoys is a list of {path, why};
//   * every `expect` path exists under that repo's root and is a regular file;
//   * 1 <= startLine <= endLine <= number of lines in the file (integers);
//   * the expected range is non-empty (contains at least one non-whitespace character);
//   * every decoy path exists (a stale decoy is a sign of drift too);
//   * with --check-hashes: sha256 (CRLF normalised to LF) of every file listed in snapshots.json
//     `touched_files_sha256` matches, i.e. the tree is the one the labels were written against.
// --dump prints the first and last line of every expected range so a human can eyeball the labels.
// Exit code 0 when everything passes, 1 otherwise (all failures are listed).

import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KINDS = new Set(["exact-name", "paraphrase", "concept", "call-path", "cross-file", "spec-artifact"]);

function parseArgs(argv) {
  const out = { roots: {}, queries: join(HERE, "queries.json"), snapshots: join(HERE, "snapshots.json"), checkHashes: false, dump: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      const v = argv[++i] ?? "";
      const eq = v.indexOf("=");
      if (eq <= 0) fatal(`--root expects <repo-name>=<dir>, got "${v}"`);
      out.roots[v.slice(0, eq)] = resolve(v.slice(eq + 1));
    } else if (a === "--queries") out.queries = resolve(argv[++i] ?? "");
    else if (a === "--snapshots") out.snapshots = resolve(argv[++i] ?? "");
    else if (a === "--check-hashes") out.checkHashes = true;
    else if (a === "--dump") out.dump = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node validate-labels.mjs --root <repo>=<dir> [--root ...] [--queries f] [--snapshots f] [--check-hashes] [--dump]");
      process.exit(0);
    } else fatal(`unknown argument "${a}"`);
  }
  return out;
}

function fatal(msg) {
  console.error(`validate-labels: ${msg}`);
  process.exit(2);
}

const lineCache = new Map();
function linesOf(abs) {
  let l = lineCache.get(abs);
  if (l === undefined) {
    const text = readFileSync(abs, "utf8").replace(/^﻿/, "");
    l = text.split(/\r?\n/);
    if (l.length > 0 && l[l.length - 1] === "") l.pop(); // a trailing newline does not add a line
    lineCache.set(abs, l);
  }
  return l;
}

const sha = (abs) => createHash("sha256").update(readFileSync(abs, "utf8").replace(/\r\n/g, "\n")).digest("hex");
const isFile = (abs) => existsSync(abs) && statSync(abs).isFile();
const nonEmptyString = (s) => typeof s === "string" && s.trim() !== "";

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.queries)) fatal(`queries file not found: ${args.queries}`);
  const doc = JSON.parse(readFileSync(args.queries, "utf8"));
  const failures = [];
  const fail = (id, msg) => failures.push(`${id}: ${msg}`);

  if (doc.schema_version !== 1) failures.push(`schema_version must be 1, got ${String(doc.schema_version)}`);
  const repos = doc.repos ?? {};
  const queries = doc.queries ?? [];
  if (!Array.isArray(queries) || queries.length === 0) failures.push("queries must be a non-empty array");

  for (const name of Object.keys(repos)) {
    if (!(name in args.roots)) failures.push(`no --root given for repo "${name}"`);
  }
  for (const name of Object.keys(args.roots)) {
    if (!(name in repos)) failures.push(`--root given for unknown repo "${name}"`);
    else if (!existsSync(args.roots[name])) failures.push(`root for "${name}" does not exist: ${args.roots[name]}`);
  }

  const seen = new Set();
  const byRepo = {};
  const byKind = {};
  for (const q of queries) {
    const id = typeof q.id === "string" ? q.id : "<missing id>";
    if (seen.has(id)) fail(id, "duplicate id");
    seen.add(id);
    if (!(q.repo in repos)) fail(id, `unknown repo "${String(q.repo)}"`);
    if (!KINDS.has(q.kind)) fail(id, `unknown kind "${String(q.kind)}"`);
    for (const f of ["query", "answer", "note"]) if (!nonEmptyString(q[f])) fail(id, `missing or empty "${f}"`);
    if (!Array.isArray(q.decoys)) fail(id, "decoys must be an array");
    if (!Array.isArray(q.expect) || q.expect.length === 0) {
      fail(id, "expect must be a non-empty array");
      continue;
    }
    if (q.kind === "cross-file" && (q.expect.length < 2 || q.expect.length > 4)) fail(id, `cross-file needs 2-4 expect locations, has ${q.expect.length}`);
    byRepo[q.repo] = (byRepo[q.repo] ?? 0) + 1;
    byKind[q.kind] = (byKind[q.kind] ?? 0) + 1;

    const root = args.roots[q.repo];
    if (root === undefined) continue;
    for (const e of q.expect) {
      const where = `expect ${String(e.path)}:${String(e.startLine)}-${String(e.endLine)}`;
      if (!nonEmptyString(e.path)) { fail(id, `${where}: missing path`); continue; }
      if (e.path.includes("\\") || e.path.startsWith("/") || e.path.split("/").includes("..")) fail(id, `${where}: path must be repo-relative with forward slashes`);
      if (/^(evals|node_modules|dist)\//.test(e.path)) fail(id, `${where}: evals/, node_modules and dist are never labelled`);
      const abs = join(root, e.path);
      if (!isFile(abs)) { fail(id, `${where}: file does not exist under ${root}`); continue; }
      if (!Number.isInteger(e.startLine) || !Number.isInteger(e.endLine)) { fail(id, `${where}: line numbers must be integers`); continue; }
      const lines = linesOf(abs);
      if (e.startLine < 1) fail(id, `${where}: startLine < 1`);
      if (e.endLine < e.startLine) fail(id, `${where}: endLine < startLine`);
      if (e.endLine > lines.length) { fail(id, `${where}: endLine beyond end of file (${lines.length} lines)`); continue; }
      if (e.startLine >= 1 && e.endLine >= e.startLine) {
        const slice = lines.slice(e.startLine - 1, e.endLine);
        if (slice.every((l) => l.trim() === "")) fail(id, `${where}: range is empty (only whitespace)`);
        if (args.dump) {
          console.log(`${id}  ${e.path}:${e.startLine}-${e.endLine}`);
          console.log(`    first: ${(lines[e.startLine - 1] ?? "").slice(0, 110)}`);
          console.log(`    last:  ${(lines[e.endLine - 1] ?? "").slice(0, 110)}`);
        }
      }
    }
    for (const d of q.decoys ?? []) {
      if (!nonEmptyString(d.path) || !nonEmptyString(d.why)) { fail(id, "decoy needs path and why"); continue; }
      if (!isFile(join(root, d.path))) fail(id, `decoy ${d.path} does not exist under ${root}`);
    }
  }

  if (args.checkHashes) {
    if (!existsSync(args.snapshots)) failures.push(`--check-hashes: snapshots file not found: ${args.snapshots}`);
    else {
      const snaps = JSON.parse(readFileSync(args.snapshots, "utf8"));
      for (const [name, s] of Object.entries(snaps.repos ?? {})) {
        const root = args.roots[name];
        if (root === undefined) continue;
        for (const [p, expected] of Object.entries(s.touched_files_sha256 ?? {})) {
          const abs = join(root, p);
          if (!isFile(abs)) { failures.push(`hash check: ${name}/${p} missing`); continue; }
          if (sha(abs) !== expected) failures.push(`hash check: ${name}/${p} differs from the labelled snapshot (tree drift)`);
        }
      }
    }
  }

  console.log(`queries: ${queries.length}`);
  console.log(`per repo: ${JSON.stringify(byRepo)}`);
  console.log(`per kind: ${JSON.stringify(byKind)}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`OK: all labels valid${args.checkHashes ? " and the trees match the labelled snapshot hashes" : ""}`);
}

main();
