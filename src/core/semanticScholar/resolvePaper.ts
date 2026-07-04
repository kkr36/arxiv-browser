import type { ResolvedPaper } from "../types";
import type { S2Paper } from "./client";

/**
 * Picks the best link for "the actual PDF of the cited paper": an
 * open-access PDF URL from Semantic Scholar if it has one, else a
 * constructed arXiv PDF link if the paper is on arXiv, else (last resort)
 * the Semantic Scholar page itself.
 */
export function toResolvedPaper(p: S2Paper): ResolvedPaper {
  const arxivId = p.externalIds?.ArXiv;
  const directPdf = p.openAccessPdf?.url || undefined;
  const arxivPdf = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined;
  const pdfUrl = directPdf ?? arxivPdf;

  let source: ResolvedPaper["source"] = "none";
  if (directPdf) source = "direct-pdf";
  else if (arxivPdf) source = "arxiv";
  else if (p.url) source = "semantic-scholar-page";

  return {
    title: p.title,
    abstract: p.abstract ?? undefined,
    authors: (p.authors ?? []).map((a) => a.name),
    year: p.year ?? undefined,
    venue: p.venue ?? undefined,
    pdfUrl,
    semanticScholarUrl: p.url,
    source,
  };
}
