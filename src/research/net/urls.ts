// URL construction for the research sources. Lives under src/research/net/ so every URL literal in the
// project stays inside the one directory the network exemption (boundary rule B4) covers.

/** Canonical resolver URL for a bare DOI. */
export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

/** Canonical abstract-page URL for a version-less arXiv id. */
export function arxivAbsUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId}`;
}
