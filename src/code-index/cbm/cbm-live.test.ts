// Suite 7c, LIVE against the real codebase-memory-mcp binary (opt-in; the binary is not part of the repository):
//
//   OSA_CBM_LIVE=1 OSA_CBM_BIN=C:/osa-cbm/bin/codebase-memory-mcp.exe OSA_CBM_WORK=C:/osa-cbm node --test src/code-index/cbm/cbm-live.test.ts
//
//   1. every spec artifact -- built from the REAL path builders (PRD under runs/<id>/, spec dir, step14 dir, the lock record and events log
//      under .osa/runs/<id>/, memory under .osa/memory, root PHASE spec) -- is indexed AND retrievable by a query about its content,
//      while a .env in the same repository is never indexed and never returned;
//   2. stale reads: after an edit / rename / delete, a query run IMMEDIATELY (before any re-index) never returns content that differs from the
//      live file, and after the incremental re-index it finds the new content and not the old.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tempGitRepo } from "../../osa/fixtures.test.ts";
import { babyPrdRelPath } from "../../osa/pipeline.ts";
import { specDirRel } from "../../osa/spec.ts";
import { step14DirRel } from "../../osa/step14.ts";
import { eventsPath } from "../../osa/events.ts";
import { prdLockRecordPath } from "../../osa/lock.ts";
import { MEMORY_DIR_REL } from "../../memory/store.ts";
import { LexicalEngine } from "../engine.ts";
import { TUNED_TUNING } from "../fusion.ts";
import { CbmEngine } from "./engine.ts";

const LIVE = process.env["OSA_CBM_LIVE"] === "1";
const BIN = process.env["OSA_CBM_BIN"] ?? "C:/osa-cbm/bin/codebase-memory-mcp.exe";
const WORK = process.env["OSA_CBM_WORK"] ?? "C:/osa-cbm";
const RUN = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const skip = LIVE ? false : "set OSA_CBM_LIVE=1 (needs the real binary; see docs/osa/CBM_NOTES.md)";

const rel = (abs: string, repo: string): string => abs.split(String.fromCharCode(92)).join("/").slice(repo.length + 1);

async function put(repo: string, path: string, text: string): Promise<void> {
  await mkdir(`${repo}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`${repo}/${path}`, text, "utf8");
}

async function openEngine(repo: string): Promise<CbmEngine> {
  return CbmEngine.open({ repoDir: repo, paths: { binaryPath: BIN, workDir: WORK }, lexical: new LexicalEngine(repo), tuning: TUNED_TUNING });
}

test("LIVE 7c: every spec artifact (real path builders, gitignored) is indexed and retrievable; a .env beside them never is", { skip, timeout: 240_000 }, async () => {
  const repo = await tempGitRepo();
  await put(repo, ".gitignore", "runs/\n.osa/\n.osa/\n.env\n");
  await put(repo, "src/billing.ts", "export function chargeInvoice(amount: number): number {\n  return amount * 1.2;\n}\n");
  await put(repo, "src/session.ts", "export function openSession(user: string): string {\n  return `session-${user}`;\n}\n");
  const artifacts: [string, string, string][] = [
    [babyPrdRelPath(RUN), "# PRD\nThe warehouse picker must confirm every bin scan with the xylophone handshake.\n", "xylophone handshake bin scan picker"],
    [`${specDirRel(RUN)}/PHASE_1_SPEC.md`, "# Phase 1\nImplement the quokka reconciliation ledger with nightly rollover.\n", "quokka reconciliation ledger nightly rollover"],
    [`${specDirRel(RUN)}/CONTEXT.md`, "# Context\nThe tundra routing table is read-only after startup.\n", "tundra routing table read-only after startup"],
    [`${step14DirRel(RUN)}/phase-1.md`, "# Phase 1 summary\nWe added the marmalade export path for auditors.\n", "marmalade export path for auditors"],
    [rel(prdLockRecordPath(repo, RUN), repo), '{"locked":true,"note":"vermilion lock record hash"}\n', "vermilion lock record hash"],
    [rel(eventsPath(repo, RUN), repo), '{"event":"spec_written","data":{"detail":"cobalt spec written event"}}\n', "cobalt spec written event"],
    [`${MEMORY_DIR_REL}/facts.md`, "- The team prefers pnpm over npm for every sandbox install.\n", "team prefers pnpm over npm sandbox install"],
    ["PHASE_2_SPEC.md", "# Phase 2\nAdd the heliotrope retry budget to the uploader.\n", "heliotrope retry budget uploader"],
  ];
  for (const [path, text] of artifacts) await put(repo, path, text);
  await put(repo, ".env", "API_TOKEN=sk-live-NEVERINDEXME9f8e7d6c5b4a\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture", "--allow-empty"], { cwd: repo, stdio: "ignore" });

  const engine = await openEngine(repo);
  try {
    const report: string[] = [];
    for (const [path, , query] of artifacts) {
      const a = await engine.search(query, { k: 5 });
      const rank = a.hits.findIndex((h) => h.path === path) + 1;
      report.push(`${path} -> rank ${String(rank)} via ${a.engine}/${a.confidence}`);
      assert.ok(rank >= 1, `spec artifact ${path} not retrievable by "${query}" (got ${a.hits.map((h) => h.path).join(", ")}) [${a.engine}]`);
    }
    process.stderr.write(`${report.join("\n")}\n`);
    for (const q of ["NEVERINDEXME API_TOKEN sk-live", "where is the API token configured"]) {
      const a = await engine.search(q, { k: 8 });
      assert.ok(!a.hits.some((h) => h.path === ".env" || h.snippet.includes("NEVERINDEXME")), `a secret leaked for "${q}"`);
    }
  } finally {
    await engine.close();
  }
});

test("LIVE 7c: stale reads -- edit, rename and delete are never served from the old index, immediately or after the incremental re-index", { skip, timeout: 300_000 }, async () => {
  const repo = await tempGitRepo();
  await put(repo, "src/rate.ts", "export function computeRateWindowZq(n: number): number {\n  return n * 60;\n}\n");
  await put(repo, "src/gone.ts", "export function purgeObsoleteLedgerQx(): void {\n  // removes rows\n}\n");
  await put(repo, "src/moved.ts", "export function relocateShipmentKw(id: string): string {\n  return id;\n}\n");
  await put(repo, "src/other.ts", "export function unrelatedThing(): number {\n  return 1;\n}\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

  const engine = await openEngine(repo);
  try {
    const before = await engine.search("computeRateWindowZq", { k: 5 });
    assert.equal(before.hits[0]?.path, "src/rate.ts", "baseline: found where it is");

    // EDIT: rename the function and shift every line down; the index still describes the old text.
    await writeFile(`${repo}/src/rate.ts`, `// header 1\n// header 2\n// header 3\nexport function computeQuotaSpanVt(n: number): number {\n  return n * 3600;\n}\n`, "utf8");
    // DELETE and RENAME
    await rm(`${repo}/src/gone.ts`);
    await rename(`${repo}/src/moved.ts`, `${repo}/src/relocated.ts`);

    for (const [q, oldPath] of [["computeRateWindowZq", "src/rate.ts"], ["purgeObsoleteLedgerQx", "src/gone.ts"], ["relocateShipmentKw", "src/moved.ts"]] as const) {
      const a = await engine.search(q, { k: 5 });
      for (const h of a.hits) {
        const live = (await readFile(`${repo}/${h.path}`, "utf8").catch(() => null))?.replace(/\r\n/g, "\n");
        assert.notEqual(live, null, `IMMEDIATE ${q}: ${h.path} no longer exists but was returned`);
        const lines = (live as string).split("\n").slice(h.startLine - 1, h.endLine).join("\n");
        assert.ok(lines.startsWith(h.snippet.split("\n")[0] as string) || h.snippet.split("\n").every((l) => lines.includes(l)), `IMMEDIATE ${q}: snippet of ${h.path}:${String(h.startLine)} is not what the file holds now`);
      }
      assert.ok(!a.hits.some((h) => h.path === oldPath && h.snippet.includes(q)), `IMMEDIATE ${q}: old content served from ${oldPath}`);
    }
    // Not vacuous: the engine noticed the index was behind the files (the edited file was returned by CBM, failed the hash check, and was dropped).
    assert.equal(engine.needsReindex, true, "a stale hit must schedule a re-index");
    assert.ok((await engine.search("computeRateWindowZq", { k: 5 })).stale.includes("src/rate.ts"), "the edited file is reported stale, not served");

    // AFTER the incremental re-index
    await engine.refresh();
    const edited = await engine.search("computeQuotaSpanVt", { k: 5 });
    assert.equal(edited.hits[0]?.path, "src/rate.ts");
    assert.match(edited.hits[0]?.snippet ?? "", /computeQuotaSpanVt/);
    const old = await engine.search("computeRateWindowZq", { k: 5 });
    assert.ok(!old.hits.some((h) => h.snippet.includes("computeRateWindowZq")), "old function name is gone from every snippet");
    assert.ok(!(await engine.search("purgeObsoleteLedgerQx", { k: 5 })).hits.some((h) => h.path === "src/gone.ts"));
    const moved = await engine.search("relocateShipmentKw", { k: 5 });
    assert.equal(moved.hits[0]?.path, "src/relocated.ts");
    assert.ok(!moved.hits.some((h) => h.path === "src/moved.ts"));
  } finally {
    await engine.close();
  }
});

test("LIVE 7e: architecture and change views -- the project overview works, and after an edit detect_changes names the changed file and the symbols (and tests) that depend on it", { skip, timeout: 300_000 }, async () => {
  const repo = await tempGitRepo();
  await put(repo, "src/core.ts", "export function computeTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n");
  await put(repo, "src/report.ts", "import { computeTotal } from './core.ts';\nexport function renderReport(items: number[]): string {\n  return `total=${computeTotal(items)}`;\n}\n");
  await put(repo, "src/report.test.ts", "import { renderReport } from './report.ts';\nexport function testReport(): boolean {\n  return renderReport([1, 2]) === 'total=3';\n}\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  const engine = await openEngine(repo);
  try {
    const arch = await engine.architecture();
    assert.ok(Number(arch["total_nodes"]) >= 6, "the overview counts the indexed symbols");
    const first = await engine.changes("impact");
    assert.equal(first.since, null, "one snapshot: nothing to compare");
    await writeFile(`${repo}/src/core.ts`, "export function computeTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0) * 1;\n}\n", "utf8");
    await engine.refresh();
    const c = await engine.changes("impact");
    assert.notEqual(c.since, null);
    assert.deepEqual(c.result["changed_files"], ["src/core.ts"]);
    const impacted = (c.result["impacted"] as { file: string }[]).map((i) => i.file).sort();
    assert.deepEqual(impacted, ["src/report.test.ts", "src/report.ts"], "the caller and the test that calls the caller");
  } finally {
    await engine.close();
  }
});
