import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupePapers, fromArxiv, fromOpenAlex, normaliseTitle } from "./dedupe.ts";
import type { PaperRecord } from "./dedupe.ts";

const rec = (over: Partial<PaperRecord>): PaperRecord => ({
  title: "A Sufficiently Long Paper Title",
  authors: [],
  year: null,
  abstract: "",
  doi: null,
  arxivId: null,
  url: "https://example.org/x",
  pdfUrl: null,
  citedByCount: null,
  references: [],
  sources: ["arxiv"],
  ...over,
});

test("dedupe by DOI first: different titles, same DOI -> one record with merged richest fields", () => {
  const a = rec({ title: "Short", doi: "10.1/x", abstract: "short abstract", sources: ["arxiv"], pdfUrl: "https://arxiv.org/pdf/1" });
  const b = rec({ title: "A much longer and better title", doi: "10.1/x", abstract: "a considerably longer abstract text", citedByCount: 40, references: ["W1", "W2"], sources: ["openalex"] });
  const out = dedupePapers([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.title, "A much longer and better title");
  assert.equal(out[0]?.abstract, "a considerably longer abstract text");
  assert.equal(out[0]?.citedByCount, 40);
  assert.equal(out[0]?.pdfUrl, "https://arxiv.org/pdf/1");
  assert.deepEqual(out[0]?.references, ["W1", "W2"]);
  assert.deepEqual([...(out[0]?.sources ?? [])].sort(), ["arxiv", "openalex"]);
  assert.equal(out[0]?.url, "https://doi.org/10.1/x");
});

test("then by arXiv id (no DOI on either), then by normalised title", () => {
  assert.equal(dedupePapers([rec({ title: "One paper", arxivId: "1612.01691" }), rec({ title: "Totally different words", arxivId: "1612.01691" })]).length, 1);
  assert.equal(dedupePapers([rec({ title: "Fleet Size & Mix: Split-Delivery Routing" }), rec({ title: "fleet size and mix split delivery routing", sources: ["openalex"] })]).length, 1);
  assert.equal(dedupePapers([rec({ title: "Fleet Size & Mix: Split-Delivery Routing" }), rec({ title: "A completely unrelated paper title" })]).length, 2);
});

test("merging is transitive across identifier kinds", () => {
  const a = rec({ title: "Alpha beta gamma delta epsilon", doi: "10.1/a" });
  const b = rec({ title: "Alpha beta gamma delta epsilon", arxivId: "2001.00001" }); // joins a by title; adds the arXiv id
  const c = rec({ title: "Something else entirely here", arxivId: "2001.00001" }); // joins via the arXiv id that b contributed
  const out = dedupePapers([a, b, c]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.doi, "10.1/a");
  assert.equal(out[0]?.arxivId, "2001.00001");
});

test("generic short titles are not merged on title alone", () => {
  assert.equal(dedupePapers([rec({ title: "Introduction" }), rec({ title: "Introduction", sources: ["openalex"] })]).length, 2);
});

test("normaliseTitle strips accents, punctuation and case; order of first appearance is preserved", () => {
  assert.equal(normaliseTitle("Étude: Résumé & Co."), "etude resume and co");
  const out = dedupePapers([rec({ title: "First paper title here", doi: "10.1/1" }), rec({ title: "Second paper title here", doi: "10.1/2" }), rec({ title: "First paper title here too", doi: "10.1/1" })]);
  assert.deepEqual(out.map((r) => r.doi), ["10.1/1", "10.1/2"]);
});

test("source conversions: arXiv and OpenAlex records map to the shared shape", () => {
  const a = fromArxiv({ arxivId: "1612.01691", title: "T", authors: ["A"], abstract: "abs", published: "2016-12-06T00:00:00Z", absUrl: "https://arxiv.org/abs/1612.01691", pdfUrl: "https://arxiv.org/pdf/1612.01691", doi: "10.1/X", categories: [] });
  assert.equal(a.year, 2016);
  assert.equal(a.doi, "10.1/x");
  const o = fromOpenAlex({ openalexId: "W1", doi: "10.1/x", title: "T", year: 2016, citedByCount: 5, abstract: "abs", landingUrl: "https://l", oaPdfUrl: null, referencedWorks: [], authors: [], arxivId: null });
  assert.equal(dedupePapers([a, o]).length, 1);
});
