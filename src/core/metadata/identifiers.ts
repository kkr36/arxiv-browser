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

/**
 * The first http(s) URL a reference carries. PDF line wrapping splits long
 * URLs with a stray space ("https://transparency.meta. com/features/…"), so
 * fragments are glued back while the previous piece ends mid-URL and the next
 * token still looks like a bare path tail rather than prose (prose resumes
 * with a capitalized word).
 */
export function extractReferenceUrl(rawText: string): string | null {
  const start = rawText.search(/https?:\/\//i);
  if (start === -1) return null;
  const tokens = rawText.slice(start).split(/\s+/);
  let url = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    if (!/[/.=-]$/.test(url)) break;
    if (!/^[a-z0-9][\w.~/%#?&=-]*$/.test(tokens[i])) break;
    url += tokens[i];
  }
  url = url.replace(/[.,;:)\]]+$/, "");
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
