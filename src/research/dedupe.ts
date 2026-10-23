// Cross-source paper de-duplication: by DOI first, then arXiv id, then normalised title (OSA_DIRECTIVE.md
// WS3.3). Pure. Records that share ANY identifier are merged into one, keeping the richest field of each
// kind (longest abstract, highest citation count, the first PDF link found) and the union of provenance.

import type { ArxivPaper } from "./net/arxiv.ts";
import type { OpenAlexWork } from "./net/openalex.ts";
import { normaliseDoi } from "./net/openalex.ts";
import { arxivAbsUrl, doiUrl } from "./net/urls.ts";
import type { S2Paper } from "./net/semantic-scholar.ts";

/** A source-independent paper record. */
export interface PaperRecord {
  readonly title: string;
  readonly authors: readonly string[];
  readonly year: number | null;
  readonly abstract: string;
  /** Bare lowercase DOI. */
  readonly doi: string | null;
  /** Version-less arXiv id. */
  readonly arxivId: string | null;
  readonly url: string;
  readonly pdfUrl: string | null;
  readonly citedByCount: number | null;
  /** OpenAlex ids of cited works (when OpenAlex was a source). */
  readonly references: readonly string[];
  /** Which sources returned it: `arxiv` | `openalex` | `semanticscholar`. */
  readonly sources: readonly string[];
}

/** `arxiv` record -> {@link PaperRecord}. */
export function fromArxiv(p: ArxivPaper): PaperRecord {
  const year = Number(p.published.slice(0, 4));
  return {
    title: p.title,
    authors: p.authors,
    year: Number.isFinite(year) && year > 0 ? year : null,
    abstract: p.abstract,
    doi: p.doi === null ? null : normaliseDoi(p.doi),
    arxivId: p.arxivId,
    url: p.absUrl,
    pdfUrl: p.pdfUrl,
    citedByCount: null,
    references: [],
    sources: ["arxiv"],
  };
}

/** `openalex` record -> {@link PaperRecord}. */
export function fromOpenAlex(w: OpenAlexWork): PaperRecord {
  return {
    title: w.title,
    authors: w.authors,
    year: w.year,
    abstract: w.abstract,
    doi: w.doi,
    arxivId: w.arxivId,
    url: w.doi !== null ? doiUrl(w.doi) : w.landingUrl,
    pdfUrl: w.oaPdfUrl,
    citedByCount: w.citedByCount,
    references: w.referencedWorks,
    sources: ["openalex"],
  };
}

/** `semanticscholar` record -> {@link PaperRecord}. */
export function fromS2(p: S2Paper): PaperRecord {
  return {
    title: p.title,
    authors: p.authors,
    year: p.year,
    abstract: p.abstract,
    doi: p.doi === null ? null : normaliseDoi(p.doi),
    arxivId: p.arxivId,
    url: p.doi !== null ? doiUrl(p.doi) : p.url,
    pdfUrl: p.oaPdfUrl,
    citedByCount: p.citedByCount,
    references: [],
    sources: ["semanticscholar"],
  };
}

/** Lowercase, accent-stripped, alphanumerics only. */
export function normaliseTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Titles shorter than this (normalised) are too generic to merge on alone. */
const MIN_TITLE_KEY_LENGTH = 20;

function keysOf(r: PaperRecord): { doi: string | null; arxiv: string | null; title: string | null } {
  const t = normaliseTitle(r.title);
  return { doi: r.doi, arxiv: r.arxivId, title: t.length >= MIN_TITLE_KEY_LENGTH ? t : null };
}

function merge(a: PaperRecord, b: PaperRecord): PaperRecord {
  const citedByCount = a.citedByCount === null ? b.citedByCount : b.citedByCount === null ? a.citedByCount : Math.max(a.citedByCount, b.citedByCount);
  const doi = a.doi ?? b.doi;
  const arxivId = a.arxivId ?? b.arxivId;
  return {
    title: a.title.length >= b.title.length ? a.title : b.title,
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    year: a.year ?? b.year,
    abstract: a.abstract.length >= b.abstract.length ? a.abstract : b.abstract,
    doi,
    arxivId,
    url: doi !== null ? doiUrl(doi) : arxivId !== null ? arxivAbsUrl(arxivId) : a.url,
    pdfUrl: a.pdfUrl ?? b.pdfUrl,
    citedByCount,
    references: a.references.length >= b.references.length ? a.references : b.references,
    sources: [...new Set([...a.sources, ...b.sources])],
  };
}

/**
 * Merges records that share a DOI, else an arXiv id, else a (long enough) normalised title. Transitive:
 * if A matches B by DOI and B matches C by title, all three become one. Order of first appearance is kept.
 */
export function dedupePapers(records: readonly PaperRecord[]): PaperRecord[] {
  const out: (PaperRecord | null)[] = [];
  const byDoi = new Map<string, number>();
  const byArxiv = new Map<string, number>();
  const byTitle = new Map<string, number>();

  const register = (idx: number, r: PaperRecord): void => {
    const k = keysOf(r);
    if (k.doi !== null) byDoi.set(k.doi, idx);
    if (k.arxiv !== null) byArxiv.set(k.arxiv, idx);
    if (k.title !== null) byTitle.set(k.title, idx);
  };

  for (const r of records) {
    const k = keysOf(r);
    const hit = (k.doi !== null ? byDoi.get(k.doi) : undefined) ?? (k.arxiv !== null ? byArxiv.get(k.arxiv) : undefined) ?? (k.title !== null ? byTitle.get(k.title) : undefined);
    if (hit === undefined) {
      out.push(r);
      register(out.length - 1, r);
    } else {
      const merged = merge(out[hit] as PaperRecord, r);
      out[hit] = merged;
      register(hit, merged);
    }
  }
  return out.filter((r): r is PaperRecord => r !== null);
}
