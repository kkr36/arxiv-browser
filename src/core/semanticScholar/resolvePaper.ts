import type { ResolvedPaper } from "../types";
import type { S2Paper } from "./client";

/**
 * Picks the best link for "the actual PDF of the cited paper": an
 * arXiv PDF if Semantic Scholar knows one, else a usable open-access PDF URL,
 * else (last resort) the Semantic Scholar page itself. arXiv is preferred
 * over publisher-hosted PDF URLs because local proxy/browser-extension fetches
 * can be blocked by bot protection even when the URL is "open access".
 */
export function toResolvedPaper(p: S2Paper): ResolvedPaper {
  const arxivId = p.externalIds?.ArXiv;
  const directPdf = p.openAccessPdf?.url || undefined;
  const arxivPdf = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined;
  const usableDirectPdf = directPdf && !isLikelyProxyHostilePdfUrl(directPdf) ? directPdf : undefined;
  const pdfUrl = arxivPdf ?? usableDirectPdf;

  let source: ResolvedPaper["source"] = "none";
  if (arxivPdf) source = "arxiv";
  else if (usableDirectPdf) source = "direct-pdf";
  else if (p.url) source = "semantic-scholar-page";

  return {
    title: p.title,
    abstract: p.abstract ?? undefined,
    authors: (p.authors ?? []).map((a) => a.name),
    authorProfiles: (p.authors ?? []).map((a) => ({
      name: a.name,
      semanticScholarAuthorId: a.authorId,
      semanticScholarUrl: a.url,
    })),
    year: p.year ?? undefined,
    venue: p.venue ?? undefined,
    pdfUrl,
    semanticScholarUrl: p.url,
    source,
  };
}

export function isLikelyProxyHostilePdfUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    const path = pathname.toLowerCase();
    return (
      (host === "dl.acm.org" && path.startsWith("/doi/pdf/")) ||
      host.endsWith("ieee.org") ||
      host.endsWith("sciencedirect.com") ||
      host.endsWith("springer.com") ||
      host.endsWith("wiley.com")
    );
  } catch {
    return false;
  }
}
