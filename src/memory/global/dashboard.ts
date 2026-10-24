// A look at the global memory store, and a way to move it: `osa memory dashboard` writes ONE self-contained HTML file (no server, no network, no
// account) with search, a project filter and a kind filter; `osa memory export` writes the facts as JSON; `osa memory import` reads such a file back
// THROUGH THE SAME CHECKS as `osa memory save` (redaction, hidden-text and instruction refusal, label rules, de-duplication), so a file can never put
// into the store what a manual save would have refused. Ids and timestamps are NOT carried over by an import: a fact gets a fresh id and the
// import time, because trusting an imported id or date would let a file overwrite or back-date rows.
//
// Every stored fact is untrusted text (it can come from a model or a web page). The page therefore never builds markup from data: the data travels as
// JSON inside a non-executing script element with `<`, `>`, `&` and the line separators escaped, and the page's own script writes it with
// `textContent` only. A Content-Security-Policy meta tag forbids every network connection and every resource except the page's own inline code.

import { existsSync } from "node:fs";
import { z } from "zod";
import { UsageError } from "../../domain/errors.ts";
import { openMemoryDb, resolveMemoryDbPath } from "./db.ts";
import { FACT_KINDS, saveFacts } from "./memory.ts";
import type { FactKind } from "./memory.ts";

/** How many facts a dashboard embeds (newest first). A page with more than this says how many it left out. */
export const DASHBOARD_MAX_FACTS = 5000;
/** The most facts one import will read, so a hostile or mistaken file cannot run for hours. */
export const IMPORT_MAX_FACTS = 50_000;

export interface DashboardFact {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly source: string | null;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DashboardData {
  readonly generatedAt: string;
  /** Every project with at least one fact, with its count and latest change. */
  readonly projects: readonly { readonly project: string; readonly count: number; readonly updatedAt: string }[];
  /** Newest first, at most {@link DASHBOARD_MAX_FACTS}. */
  readonly facts: readonly DashboardFact[];
  /** All facts in the store (for the "N of M" line); `total - facts.length` were left out of the page. */
  readonly total: number;
}

/**
 * Reads the store for the dashboard or an export. READ-ONLY in effect: when there is no database file yet it returns empty data and creates
 * nothing (opening the store would create it). `project` limits the facts to one project.
 */
export function readDashboardData(opts: { readonly dbPath?: string; readonly project?: string; readonly limit?: number; readonly now?: () => string } = {}): DashboardData {
  const generatedAt = (opts.now ?? ((): string => new Date().toISOString()))();
  const resolved = resolveMemoryDbPath(opts.dbPath);
  if (!existsSync(resolved)) return { generatedAt, projects: [], facts: [], total: 0 };
  const limit = Math.max(1, Math.min(opts.limit ?? DASHBOARD_MAX_FACTS, 1_000_000));
  const mem = openMemoryDb(opts.dbPath);
  try {
    const where = opts.project === undefined ? "deleted_at IS NULL" : "deleted_at IS NULL AND project = ?";
    const args = opts.project === undefined ? [] : [opts.project];
    const projects = (mem.db.prepare(`SELECT project, COUNT(*) AS count, MAX(updated_at) AS updated_at FROM facts WHERE ${where} GROUP BY project ORDER BY project ASC`).all(...args) as { project: string; count: number; updated_at: string }[]).map((r) => ({
      project: r.project,
      count: Number(r.count),
      updatedAt: r.updated_at,
    }));
    const rows = mem.db.prepare(`SELECT id, project, kind, source, text, created_at, updated_at FROM facts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit) as {
      id: string;
      project: string;
      kind: string;
      source: string | null;
      text: string;
      created_at: string;
      updated_at: string;
    }[];
    return {
      generatedAt,
      projects,
      facts: rows.map((r) => ({ id: r.id, project: r.project, kind: r.kind, source: r.source ?? null, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at })),
      total: projects.reduce((n, p) => n + p.count, 0),
    };
  } finally {
    mem.close();
  }
}

/** JSON that is safe to place inside an HTML script element: nothing in it can close the element, start a comment, or end a JavaScript string early. Pure. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const PAGE_SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('osa-data').textContent);
  var q = document.getElementById('q');
  var sp = document.getElementById('project');
  var sk = document.getElementById('kind');
  var list = document.getElementById('list');
  var count = document.getElementById('count');
  var more = document.getElementById('more');
  var shown = 200;
  function fill(select, values) {
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    });
  }
  fill(sp, data.projects.map(function (p) { return p.project; }));
  fill(sk, ['fact', 'decision', 'note']);
  var tbody = document.getElementById('projects');
  data.projects.forEach(function (p) {
    var tr = document.createElement('tr');
    [p.project, String(p.count), p.updatedAt.slice(0, 10)].forEach(function (cell) {
      var td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    });
    tr.addEventListener('click', function () { sp.value = p.project; shown = 200; render(); });
    tbody.appendChild(tr);
  });
  function matches(f, terms) {
    var hay = (f.text + ' ' + f.project + ' ' + (f.source || '')).toLowerCase();
    for (var i = 0; i < terms.length; i++) { if (hay.indexOf(terms[i]) < 0) return false; }
    return true;
  }
  function render() {
    var terms = q.value.toLowerCase().split(' ').filter(function (t) { return t !== ''; });
    var rows = data.facts.filter(function (f) {
      return (sp.value === '' || f.project === sp.value) && (sk.value === '' || f.kind === sk.value) && matches(f, terms);
    });
    var left = data.total - data.facts.length;
    count.textContent = rows.length + ' shown of ' + data.total + ' fact' + (data.total === 1 ? '' : 's') + (left > 0 ? ' (' + left + ' older ones are not in this page)' : '');
    list.textContent = '';
    rows.slice(0, shown).forEach(function (f) {
      var li = document.createElement('li');
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = f.kind + ' \\u00b7 ' + f.project + ' \\u00b7 ' + f.createdAt.slice(0, 10) + (f.source ? ' \\u00b7 ' + f.source : '');
      var body = document.createElement('div');
      body.textContent = f.text;
      li.appendChild(meta);
      li.appendChild(body);
      list.appendChild(li);
    });
    more.hidden = rows.length <= shown;
  }
  more.addEventListener('click', function () { shown += 200; render(); });
  [q, sp, sk].forEach(function (el) { el.addEventListener('input', function () { shown = 200; render(); }); });
  render();
})();
`;

const PAGE_STYLE = `
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #6b6560; --line: #e0dcd6; --card: #ffffff; --accent: #2f6f5e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece8e2; --muted: #9a948b; --line: #34312d; --card: #1f1d1a; --accent: #6fbfa8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
input, select, button { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
input { flex: 1 1 260px; }
#count { color: var(--muted); margin: 8px 0 12px; }
ul { list-style: none; margin: 0; padding: 0; }
li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
.meta { color: var(--muted); font-size: 12.5px; margin-bottom: 4px; white-space: normal; }
table { width: 100%; border-collapse: collapse; margin: 0 0 24px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--card); }
.hint { color: var(--muted); font-size: 13.5px; margin-top: 28px; }
code { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
`;

/** The dashboard page for `data`. Pure; contains no network reference and builds no markup from data. */
export function renderDashboard(data: DashboardData): string {
  const generated = data.generatedAt.replace(/[^0-9TZ:.\- ]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>OSA memory</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>OSA memory</h1>
<p class="sub">What OSA remembers across your projects. This page is a snapshot from ${generated}; it reads nothing and sends nothing.</p>
<table>
<thead><tr><th>Project</th><th>Facts</th><th>Last change</th></tr></thead>
<tbody id="projects"></tbody>
</table>
<div class="bar">
<input id="q" type="search" placeholder="Search facts, projects and sources" autocomplete="off" aria-label="Search">
<select id="project" aria-label="Project"><option value="">All projects</option></select>
<select id="kind" aria-label="Kind"><option value="">All kinds</option></select>
</div>
<div id="count"></div>
<ul id="list"></ul>
<button id="more" hidden>Show more</button>
<p class="hint">This is a copy. To remove something, run <code>osa memory forget --project &lt;name&gt;</code> (or <code>--all --yes</code>) and write a new page with <code>osa memory dashboard</code>. To move your memory to another machine, use <code>osa memory export</code> and <code>osa memory import</code>.</p>
</main>
<script type="application/json" id="osa-data">${jsonForScript({ projects: data.projects, facts: data.facts, total: data.total })}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

// ---- export / import ----

const ExportedFact = z.strictObject({
  project: z.string().min(1).max(500),
  kind: z.enum(FACT_KINDS),
  source: z.string().max(1000).nullable().optional(),
  text: z.string().min(1).max(20_000),
  // Carried in the file for a person's records; an import ignores them (see the header).
  id: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

const ExportFile = z.strictObject({
  format: z.literal("osa-memory-export"),
  version: z.literal(1),
  exportedAt: z.string().max(100),
  facts: z.array(ExportedFact).max(IMPORT_MAX_FACTS),
});
export type ExportFile = z.infer<typeof ExportFile>;

/** The export file for the store (or one project). Oldest first, so an import replays them in the order they were learned. Pure given `data`. */
export function buildExport(data: DashboardData): ExportFile {
  return {
    format: "osa-memory-export",
    version: 1,
    exportedAt: data.generatedAt,
    facts: [...data.facts].reverse().map((f) => ({ id: f.id, project: f.project, kind: f.kind as FactKind, source: f.source, text: f.text, createdAt: f.createdAt, updatedAt: f.updatedAt })),
  };
}

export interface ImportResult {
  readonly saved: number;
  readonly deduped: number;
  /** Facts the store's checks refused (secret-shaped, instruction-like, hidden text, a bad label, over-length ...). */
  readonly refused: number;
  readonly total: number;
}

/**
 * Imports an export file's text. A malformed file is a {@link UsageError}; a fact the store would refuse is counted, never stored. Every fact goes through
 * `saveFacts`, i.e. exactly the checks of `osa memory save`. `project` (optional) overrides every fact's project.
 */
export function importExport(fileText: string, opts: { readonly dbPath?: string; readonly project?: string } = {}): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fileText);
  } catch {
    throw new UsageError("memory import: the file is not valid JSON.");
  }
  const parsed = ExportFile.safeParse(raw);
  if (!parsed.success) throw new UsageError("memory import: the file is not an OSA memory export (expected format osa-memory-export, version 1).");
  let saved = 0;
  let deduped = 0;
  let refused = 0;
  const facts = parsed.data.facts;
  for (let i = 0; i < facts.length; i += 200) {
    const batch = facts.slice(i, i + 200);
    const results = saveFacts(batch.map((f) => ({ text: f.text, project: opts.project ?? f.project, kind: f.kind, ...(f.source !== undefined && f.source !== null ? { source: f.source } : {}) })), {
      ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
    });
    for (const r of results) {
      if (!r.ok) refused += 1;
      else if (r.result.deduped) deduped += 1;
      else saved += 1;
    }
  }
  return { saved, deduped, refused, total: facts.length };
}
