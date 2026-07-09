/**
 * Identifier extraction from raw bibliography text. Dependency-free on
 * purpose: the Vite dev-server middleware and the extension background script
 * import these too, where browser-only modules can't be loaded.
 */

/** Finds an explicit arXiv id in reference text ("arXiv preprint
 * arXiv:2310.05130", "arxiv.org/abs/2310.05130", old-style "cs/0112017"). */
export function extractArxivId(rawText: string): string | null {
  const modern = rawText.match(/\barxiv(?:\.org)?[:\s/]*(?:abs\/|pdf\/)?(\d{4}\.\d{4,5})(?:v\d+)?\b/i);
  if (modern) return modern[1];
  const old = rawText.match(/\barxiv(?:\.org)?[:\s/]*(?:abs\/)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/i);
  return old ? old[1] : null;
}

/** Finds an explicit DOI in reference text. */
export function extractDoi(rawText: string): string | null {
  const m = rawText.match(/\b10\.\d{4,9}\/[^\s"<>]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, "") : null;
}

/** The arXiv id encoded in an arXiv-assigned DOI (10.48550/arXiv.<id>). */
export function arxivIdFromDoi(doi: string): string | null {
  const m = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : null;
}
