// Suite 5, LIVE (opt-in: OSA_NET_LIVE=1): the real arXiv and OpenAlex APIs on a NON-computer-science topic (hostel / dormitory room
// allocation, an operations-research problem). arXiv is a preprint server weighted to CS/physics/maths; OpenAlex indexes journals.
// The point of the OpenAlex leg of WS3 is that it finds the literature arXiv does not. Pass: OpenAlex returns works that are NOT on
// arXiv (journal or conference papers with their own DOI) and that arXiv's results do not contain. Prints the evidence for the report.
//
//   OSA_NET_LIVE=1 node --test src/research/net/live.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAcademicSearch } from "../academic.ts";
import { normaliseTitle as normaliseTitleForTest } from "../dedupe.ts";
import { MemoryEventSink } from "../../osa/events.ts";
import { searchArxiv } from "./arxiv.ts";
import { searchOpenAlex } from "./openalex.ts";

const LIVE = process.env["OSA_NET_LIVE"] === "1";
const QUERIES = ["university dormitory room allocation optimization", "student housing assignment problem operations research"];

/** An outage of the remote service (timeout, 429, 5xx) -- not an OSA defect, and not something this test can prove anything through. */
const OUTAGE = /aborted|timed? ?out|429|5dd|rate|unavailable|ECONN|fetch failed/i;

/** arXiv's API is slow and rate-limited; give it three tries 20 s apart before calling the answer an outage. */
async function arxivTry(q: string): Promise<Awaited<ReturnType<typeof searchArxiv>>> {
  let last = await searchArxiv(q, { maxResults: 10 });
  for (let i = 0; i < 2 && last.problem !== null && OUTAGE.test(last.problem); i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    last = await searchArxiv(q, { maxResults: 10 });
  }
  return last;
}

test("LIVE (OSA_NET_LIVE=1): OpenAlex finds journal literature on hostel / dormitory allocation that arXiv misses", { skip: LIVE ? false : "set OSA_NET_LIVE=1", timeout: 300_000 }, async (t) => {
  const arxivTitles = new Set<string>();
  const arxivDois = new Set<string>();
  const openalex: { title: string; doi: string | null; arxivId: string | null; year: number | null; cited: number }[] = [];
  let arxivCount = 0;
  for (const q of QUERIES) {
    const ax = await arxivTry(q);
    if (ax.problem !== null && OUTAGE.test(ax.problem)) {
      // Inconclusive, not passed: "arXiv misses these works" cannot be shown while arXiv is not answering. The skip reason lands in the report.
      t.skip(`arXiv did not answer after 3 tries (${ax.problem}); the claim is not proven this run`);
      return;
    }
    assert.equal(ax.problem, null, `arXiv: ${ax.problem ?? ""}`);
    arxivCount += ax.records.length;
    for (const p of ax.records) {
      arxivTitles.add(normaliseTitleForTest(p.title));
      if (p.doi !== null) arxivDois.add(p.doi.toLowerCase());
    }
    const oa = await searchOpenAlex(q, { perPage: 10 });
    assert.equal(oa.problem, null, `OpenAlex: ${oa.problem ?? ""}`);
    for (const w of oa.records) openalex.push({ title: w.title, doi: w.doi, arxivId: w.arxivId, year: w.year, cited: w.citedByCount });
  }
  const journalLike = openalex.filter((w) => w.arxivId === null && w.doi !== null && !w.doi.startsWith("10.48550/") && !arxivTitles.has(normaliseTitleForTest(w.title)) && !arxivDois.has(w.doi));
  process.stdout.write(`\n[net-live] queries: ${QUERIES.join(" | ")}\n[net-live] arXiv returned ${String(arxivCount)} record(s); OpenAlex returned ${String(openalex.length)}; OpenAlex-only journal/conference works: ${String(journalLike.length)}\n`);
  for (const w of journalLike.slice(0, 6)) process.stdout.write(`[net-live]   ${String(w.year)} cited ${String(w.cited)}x  doi:${w.doi ?? ""}  ${w.title.slice(0, 90)}\n`);
  assert.ok(openalex.length > 0, "OpenAlex answered");
  assert.ok(journalLike.length >= 1, "OpenAlex returned at least one non-arXiv work that arXiv's results do not contain");
});

test("LIVE (OSA_NET_LIVE=1): the whole academic step on that topic keeps relevant works, logs one event per query, and never throws", { skip: LIVE ? false : "set OSA_NET_LIVE=1", timeout: 300_000 }, async () => {
  const events = new MemoryEventSink();
  const res = await runAcademicSearch({ queries: QUERIES, events, env: {} });
  const q = events.events.filter((e) => e.event === "academic_query");
  assert.equal(q.length, QUERIES.length);
  process.stdout.write(`[net-live] runAcademicSearch kept ${String(res.papers.length)} paper(s): ${res.papers.map((p) => `${p.year ?? "?"} ${p.title.slice(0, 50)} [${p.sources.join("+")}]`).slice(0, 5).join(" ;; ")}\n[net-live] per-query: ${JSON.stringify(res.queries.map((r) => ({ arxiv: r.arxiv, openalex: r.openalex, merged: r.merged, relevant: r.relevant, problems: r.problems })))}\n`);
  assert.ok(res.queries.every((r) => r.problems.length === 0 || r.problems.every((p) => /OpenAlex|rate|budget|key/i.test(p) || OUTAGE.test(p))), "no unexplained source problems (a remote outage is explained: it is logged in the query's problems, and the step still answered from the other source)");
  assert.ok(res.papers.length > 0, "the step still returned works from the source that answered");
});
