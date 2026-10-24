// Documentation-research reuse (docs/osa/memory-phase3/SPEC.md): docsKey / isFresh, rememberItems, findReusable, the
// row cap, the secret/size refusals, and that forget removes remembered rows and leaves no text in the file or its -wal.
// Every test uses a temp dbPath and never touches the real home directory. Fake tokens are split so push protection does
// not block them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecret } from "../secrets.ts";
import { openMemoryDb } from "./db.ts";
import { forgetMemory } from "./memory.ts";
import { MAX_RESEARCH_ROWS, docsKey, findReusable, isFresh, rememberItems } from "./research.ts";

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "osa-gmem-"));
  return join(dir, "memory.db");
}

const NOW = new Date("2026-10-24T00:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function docResult(version: string): string {
  return (
    JSON.stringify(
      {
        summary: "Findings.",
        key_findings: ["a finding"],
        recommendations: ["a recommendation"],
        as_of: "2026-10-01",
        current_version: version,
        api_surface: ["fn"],
        pitfalls: ["none"],
        sources: [{ title: "Docs", url: "https://example.org/docs", type: "official-docs", quote: "q" }],
        uncertain: [],
      },
      null,
      2,
    ) + "\n"
  );
}

test("docsKey folds case, NFKC and whitespace, trims trailing punctuation, and keeps a prefix distinct (FM-G)", () => {
  assert.equal(docsKey("React"), "react");
  assert.equal(docsKey("  React   JS  "), "react js");
  assert.equal(docsKey("Express.js."), "express.js");
  assert.notEqual(docsKey("react"), docsKey("react-native"), "a prefix of another name keys differently");
});

test("isFresh is inclusive at the boundary and false for older or unparseable timestamps (FM-A)", () => {
  assert.equal(isFresh(daysAgo(30), 30, NOW), true, "exactly at the window is still fresh");
  assert.equal(isFresh(daysAgo(31), 30, NOW), false, "older than the window is stale");
  assert.equal(isFresh("not-a-date", 30, NOW), false);
});

test("rememberItems stores one row per key, a newer result replaces the older one, and findReusable returns the parsed result with provenance", () => {
  return (async () => {
    const dbPath = await tempDbPath();
    rememberItems([{ target: "React", title: "Official documentation: React", resultJson: docResult("18.0"), checkLevel: "full", project: "proj-a", createdAt: daysAgo(10) }], { dbPath });
    // A newer run of the same technology replaces the row.
    rememberItems([{ target: "react", title: "Official documentation: react", resultJson: docResult("19.0"), checkLevel: "full", project: "proj-b", createdAt: daysAgo(2) }], { dbPath });

    const mem = openMemoryDb(dbPath);
    try {
      const rows = mem.db.prepare("SELECT COUNT(*) AS n FROM research_items WHERE deleted_at IS NULL").get() as { n: number };
      assert.equal(rows.n, 1, "one row per key");
    } finally {
      mem.close();
    }

    const found = findReusable(["React"], { dbPath, maxAgeDays: 30, now: NOW });
    const got = found.get("react");
    assert.ok(got !== undefined, "the remembered result is reusable");
    assert.equal(got?.result["current_version"], "19.0", "the newer result won");
    assert.equal(got?.project, "proj-b");
    assert.equal(got?.ageDays, 2);
  })();
});

test("findReusable does not serve a stale entry; the boundary one is served (FM-A)", async () => {
  const dbPath = await tempDbPath();
  rememberItems([{ target: "Stale", title: "Official documentation: Stale", resultJson: docResult("1.0"), checkLevel: "full", project: "p", createdAt: daysAgo(31) }], { dbPath });
  rememberItems([{ target: "Edge", title: "Official documentation: Edge", resultJson: docResult("1.0"), checkLevel: "full", project: "p", createdAt: daysAgo(30) }], { dbPath });
  const found = findReusable(["Stale", "Edge"], { dbPath, maxAgeDays: 30, now: NOW });
  assert.equal(found.has("stale"), false, "the stale entry is not served");
  assert.equal(found.has("edge"), true, "the boundary entry is served");
});

test("findReusable queries exact keys: react-native is never served for react (FM-G)", async () => {
  const dbPath = await tempDbPath();
  rememberItems([{ target: "React Native", title: "Official documentation: React Native", resultJson: docResult("0.76"), checkLevel: "full", project: "p", createdAt: daysAgo(1) }], { dbPath });
  const found = findReusable(["React"], { dbPath, maxAgeDays: 30, now: NOW });
  assert.equal(found.size, 0, "a different technology whose name shares a prefix is not matched");
});

test("rememberItems refuses an over-size result and one that is still secret-shaped; nothing secret reaches the table (remember guard)", async () => {
  const dbPath = await tempDbPath();
  const huge = JSON.stringify({ summary: "x".repeat(70_000) }) + "\n";
  const secret = JSON.stringify({ summary: "token is ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" }) + "\n";
  const r = rememberItems(
    [
      { target: "Big", title: "Official documentation: Big", resultJson: huge, checkLevel: "full", project: "p", createdAt: daysAgo(1) },
      { target: "Leaky", title: "Official documentation: Leaky", resultJson: secret, checkLevel: "full", project: "p", createdAt: daysAgo(1) },
    ],
    { dbPath },
  );
  assert.equal(r.stored, 0);
  assert.equal(r.refused, 2);
  const mem = openMemoryDb(dbPath);
  try {
    const rows = mem.db.prepare("SELECT result FROM research_items").all() as { result: string }[];
    assert.equal(rows.length, 0, "neither refused result was stored");
    assert.ok(rows.every((x) => findSecret(x.result) === null));
  } finally {
    mem.close();
  }
});

test("FM-I: the live-row cap evicts the oldest", async () => {
  const dbPath = await tempDbPath();
  const records = Array.from({ length: MAX_RESEARCH_ROWS + 5 }, (_v, i) => ({
    target: `tech-${String(i)}`,
    title: `Official documentation: tech-${String(i)}`,
    resultJson: docResult("1.0"),
    checkLevel: "full" as const,
    project: "p",
    createdAt: daysAgo(MAX_RESEARCH_ROWS + 5 - i), // lower i == older
  }));
  rememberItems(records, { dbPath });
  const mem = openMemoryDb(dbPath);
  try {
    const n = mem.db.prepare("SELECT COUNT(*) AS n FROM research_items WHERE deleted_at IS NULL").get() as { n: number };
    assert.equal(n.n, MAX_RESEARCH_ROWS, "the cap holds");
    const oldest = mem.db.prepare("SELECT dkey FROM research_items WHERE dkey = 'tech-0'").get();
    assert.equal(oldest, undefined, "the oldest row was evicted");
  } finally {
    mem.close();
  }
});

test("FM-H: forget --project removes only that project's remembered research; --all removes all; the text is gone from the file and -wal", async () => {
  const dbPath = await tempDbPath();
  const marker = "ZZ-forgettable-target-text-ZZ";
  rememberItems(
    [
      { target: marker, title: `Official documentation: ${marker}`, resultJson: docResult("1.0"), checkLevel: "full", project: "doomed", createdAt: daysAgo(1) },
      { target: "Keeper", title: "Official documentation: Keeper", resultJson: docResult("1.0"), checkLevel: "full", project: "safe", createdAt: daysAgo(1) },
    ],
    { dbPath },
  );

  const r = forgetMemory({ project: "doomed" }, { dbPath });
  assert.equal(r.research, 1, "only the one project's row was forgotten");
  assert.equal(findReusable([marker], { dbPath, maxAgeDays: 30, now: NOW }).size, 0);
  assert.equal(findReusable(["Keeper"], { dbPath, maxAgeDays: 30, now: NOW }).size, 1, "the other project is untouched");

  // The forgotten target text survives in neither the file nor its write-ahead log.
  const fileText = await readFile(dbPath, "utf8").catch(() => "");
  const walText = await readFile(`${dbPath}-wal`, "utf8").catch(() => "");
  assert.ok(!fileText.includes(marker), "the forgotten text is not in the database file");
  assert.ok(!walText.includes(marker), "the forgotten text is not in the -wal");

  const all = forgetMemory({ all: true }, { dbPath });
  assert.equal(all.research, 1, "the remaining project's row is removed by --all");
});
