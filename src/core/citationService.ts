import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { extractAllPageText } from "./pdf/extractText";
import { parseBibliography } from "./citations/parseBibliography";
import { detectMarkersOnPage, type ExcludedRange } from "./citations/detectMarkers";
import { matchMarkersToEntries } from "./citations/matchMarkersToEntries";
import { guessTitle, matchPaperByReferenceText, type S2Paper } from "./semanticScholar/client";
import { isLikelyProxyHostilePdfUrl, toResolvedPaper } from "./semanticScholar/resolvePaper";
import { extractArxivId, extractDoi, extractReferenceUrl } from "./metadata/identifiers";
import { titlesRoughlyEqual } from "./metadata/titleMatch";
import {
  crossrefWorkToResolvedPaper,
  getCrossrefWorkByDoi,
  matchCrossrefBibliographic,
} from "./metadata/crossref";
import { matchOaWorkByTitle, oaWorkToResolvedPaper } from "./metadata/openalex";
import { findUnpaywallPdfUrl } from "./metadata/unpaywall";
import { fetchArxivById, searchArxivByTitle } from "./arxiv/searchArxiv";
import type { BibEntry, CitationMarker, PageText, ResolvedPaper } from "./types";
import { findPublicPdf } from "./webPdfSearch";

export interface CitationData {
  pages: PageText[];
  entries: BibEntry[];
  markersByPage: Map<number, CitationMarker[]>;
}

export async function buildCitationData(doc: PDFDocumentProxy): Promise<CitationData> {
  const pages = await extractAllPageText(doc);
  const bibliography = parseBibliography(pages);
  const entries = bibliography?.entries ?? [];

  const markersByPage = new Map<number, CitationMarker[]>();
  for (const page of pages) {
    // Exclude the bibliography itself from marker detection (its entry
    // numbers and page ranges would otherwise match as in-text citations),
    // but resume afterwards — appendices routinely cite works too.
    let exclude: ExcludedRange | undefined;
    if (bibliography) {
      const { headingPage, headingStart, endPage, endOffset } = bibliography;
      const inBibRange =
        page.pageNumber >= headingPage && (endPage === null || page.pageNumber <= endPage);
      if (inBibRange) {
        exclude = {
          start: page.pageNumber === headingPage ? headingStart : 0,
          end: endPage !== null && page.pageNumber === endPage ? (endOffset ?? Infinity) : Infinity,
        };
      }
    }

    const raw = detectMarkersOnPage(page, exclude, bibliography?.style);
    const matched = matchMarkersToEntries(raw, entries);
    if (matched.length > 0) markersByPage.set(page.pageNumber, matched);
  }

  return { pages, entries, markersByPage };
}

const resolutionCache = new Map<number, Promise<ResolvedPaper | null>>();

/** Clears the in-memory resolution cache; call when loading a new paper. */
export function resetResolutionCache(): void {
  resolutionCache.clear();
}

export function resolveEntry(entries: BibEntry[], entryIndex: number): Promise<ResolvedPaper | null> {
  const cached = resolutionCache.get(entryIndex);
  if (cached) return cached;

  const entry = entries[entryIndex];
  const promise = (async () => {
    // v7: bumped when detached-diacritic repair fixed title/key extraction,
    // wrong-paper guards were added to the S2/OpenAlex fallbacks, and
    // URL-only references started resolving to their own web page — cached
    // results from before could point at entirely wrong papers.
    //
    // v6: bumped when no-PDF metadata matches started continuing through
    // arXiv/public-PDF discovery instead of stopping at page-only records.
    //
    // v5: bumped when the resolution pipeline moved from Semantic Scholar
    // to arXiv/Crossref/OpenAlex, so stale S2-era results get re-resolved.
    const cacheKey = `arxiv-browser:resolve-v7:${entry.rawText.slice(0, 120)}`;
    const stored = safeLocalStorageGet(cacheKey);
    if (stored) {
      try {
        return JSON.parse(stored) as ResolvedPaper;
      } catch {
        // corrupt cache entry; fall through and re-fetch
      }
    }

    const resolved = await resolveRawReference(entry.rawText);
    if (!resolved) return null;

    safeLocalStorageSet(cacheKey, JSON.stringify(resolved));
    return resolved;
  })();

  resolutionCache.set(entryIndex, promise);
  // A rejection is transient (rate limit, network) — evict it so the next
  // hover retries instead of showing a failure for the rest of the session.
  // A resolved `null` is a genuine no-match and stays cached.
  promise.catch(() => resolutionCache.delete(entryIndex));
  return promise;
}

/**
 * Fast identifier-first resolution. An explicit arXiv id goes straight to
 * the arXiv API (authoritative for arXiv papers, always has the PDF); an
 * explicit DOI goes to Crossref for metadata with Unpaywall fetching an
 * open-access PDF in parallel. Otherwise Crossref's citation-string matcher
 * and an OpenAlex title search race in parallel, both guarded by strict
 * title validation. Semantic Scholar — slow and aggressively rate-limited —
 * is kept only as the last resort.
 */
async function resolveRawReference(rawText: string): Promise<ResolvedPaper | null> {
  const arxivId = extractArxivId(rawText);
  if (arxivId) {
    const byId = await fetchArxivById(arxivId);
    if (byId) return byId;
    // The id alone is still enough to fetch the PDF.
    return {
      title: guessTitle(rawText) ?? rawText.slice(0, 120),
      authors: [],
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      source: "arxiv",
    };
  }

  const title = guessTitle(rawText);

  const doi = extractDoi(rawText);
  if (doi) {
    const [crossref, oaPdfUrl] = await Promise.all([
      getCrossrefWorkByDoi(doi).catch(() => null),
      findUnpaywallPdfUrl(doi).catch(() => null),
    ]);
    if (crossref) {
      const resolved = crossrefWorkToResolvedPaper(crossref);
      if (resolved) return withBestDiscoveredPdf(resolved, rawText, title, oaPdfUrl);
    }
  }

  const [crossrefMatch, openAlexWork] = await Promise.all([
    matchCrossrefBibliographic(rawText, title).catch(() => null),
    title ? matchOaWorkByTitle(title).catch(() => null) : Promise.resolve(null),
  ]);
  const crossrefPaper = crossrefMatch ? crossrefWorkToResolvedPaper(crossrefMatch) : null;
  const openAlexPaper = openAlexWork ? oaWorkToResolvedPaper(openAlexWork) : null;
  const merged = mergeResolvedCandidates(crossrefPaper, openAlexPaper);
  if (merged) {
    if (merged.pdfUrl) return merged;
    const oaPdfUrl = merged.doi ? await findUnpaywallPdfUrl(merged.doi).catch(() => null) : null;
    return withBestDiscoveredPdf(merged, rawText, title, oaPdfUrl);
  }

  const foundByTitle = await withBestDiscoveredPdf(null, rawText, title);
  if (foundByTitle) return foundByTitle;

  // No scholarly index knows this reference, but it links a web page itself
  // (corporate newsroom posts, standards, reports). The reference's own URL
  // is authoritative — better a correct web page than a fuzzy-search PDF of
  // some unrelated paper.
  const referenceUrl = extractReferenceUrl(rawText);
  if (referenceUrl) {
    return {
      title: title ?? rawText.slice(0, 120),
      authors: [],
      pageUrl: referenceUrl,
      source: "page",
    };
  }

  const s2 = await resolveViaSemanticScholar(rawText);
  return s2 ? withBestDiscoveredPdf(s2, rawText, title) : null;
}

async function withBestDiscoveredPdf(
  base: ResolvedPaper | null,
  rawText: string,
  guessedTitle: string | null,
  oaPdfUrl?: string | null,
): Promise<ResolvedPaper | null> {
  if (base?.pdfUrl) return base;

  // arXiv is tried before an in-hand open-access URL: publisher OA hosts
  // (AAAI's OJS included) intermittently stall or bot-block non-browser
  // fetches, while arXiv PDFs always render.
  const title = guessedTitle ?? base?.title ?? guessTitle(rawText);
  if (title) {
    const arxiv = await searchArxivByTitle(title).catch(() => null);
    if (arxiv) return mergeResolvedCandidates(base, arxiv);
  }

  if (base && oaPdfUrl) return { ...base, pdfUrl: oaPdfUrl, source: "direct-pdf" };

  const publicPdf = await findPublicPdf({ title: title ?? undefined, rawText }).catch(() => null);
  if (!publicPdf) return base;

  const fallbackTitle = title ?? rawText.slice(0, 120);
  return {
    title: base?.title ?? publicPdf.title ?? fallbackTitle,
    abstract: base?.abstract,
    authors: base?.authors ?? [],
    authorProfiles: base?.authorProfiles,
    year: base?.year,
    venue: base?.venue,
    doi: base?.doi,
    pageUrl: base?.pageUrl,
    semanticScholarUrl: base?.semanticScholarUrl,
    pdfUrl: publicPdf.pdfUrl,
    source: publicPdf.pdfUrl.includes("arxiv.org/pdf/") ? "arxiv" : "direct-pdf",
  };
}

/**
 * Combines the two parallel title-match results. Whichever candidate found a
 * PDF (arXiv preferred) wins as the base; the other fills gaps — in practice
 * Crossref has the cleaner venue/year and OpenAlex the abstract and author
 * ids, so merging beats either alone.
 */
function mergeResolvedCandidates(
  crossref: ResolvedPaper | null,
  openAlex: ResolvedPaper | null,
): ResolvedPaper | null {
  if (!crossref || !openAlex) return crossref ?? openAlex;
  const rank = (p: ResolvedPaper) => (p.source === "arxiv" ? 2 : p.pdfUrl ? 1 : 0);
  const [base, other] = rank(openAlex) > rank(crossref) ? [openAlex, crossref] : [crossref, openAlex];
  return {
    ...base,
    abstract: base.abstract ?? other.abstract,
    authors: base.authors.length > 0 ? base.authors : other.authors,
    authorProfiles: pickRicherAuthorProfiles(base, other),
    year: base.year ?? other.year,
    venue: base.venue ?? other.venue,
    doi: base.doi ?? other.doi,
    pdfUrl: base.pdfUrl ?? other.pdfUrl,
    pageUrl: base.pageUrl ?? other.pageUrl,
  };
}

function pickRicherAuthorProfiles(base: ResolvedPaper, other: ResolvedPaper) {
  const hasIds = (p: ResolvedPaper) =>
    p.authorProfiles?.some((a) => a.openAlexAuthorId) ?? false;
  if (!hasIds(base) && hasIds(other)) return other.authorProfiles;
  return base.authorProfiles ?? other.authorProfiles;
}

/** Last-resort path preserving the old pipeline's S2 behavior, including the
 * swap to an arXiv PDF when S2's open-access URL is behind bot protection.
 * S2's general search always returns *something*, so the hit only counts when
 * it demonstrably matches the reference. */
async function resolveViaSemanticScholar(rawText: string): Promise<ResolvedPaper | null> {
  const s2 = await matchPaperByReferenceText(rawText);
  if (!s2 || !s2MatchLooksRight(s2, rawText)) return null;
  const resolved = toResolvedPaper(s2);
  const directPdf = s2.openAccessPdf?.url;
  if (directPdf && isLikelyProxyHostilePdfUrl(directPdf) && resolved.source !== "arxiv") {
    const title = guessTitle(rawText);
    const arxiv = title ? await searchArxivByTitle(title) : null;
    if (arxiv?.pdfUrl) {
      return {
        ...resolved,
        abstract: resolved.abstract ?? arxiv.abstract,
        authors: resolved.authors.length > 0 ? resolved.authors : arxiv.authors,
        year: resolved.year ?? arxiv.year,
        venue: resolved.venue ?? arxiv.venue,
        pdfUrl: arxiv.pdfUrl,
        source: "arxiv",
      };
    }
  }
  return resolved;
}

/** Same guard shape as `crossrefMatchLooksRight`: near-exact title match when
 * a title could be extracted, else the hit's first-author surname and year
 * must both literally appear in the reference text. */
function s2MatchLooksRight(s2: S2Paper, rawText: string): boolean {
  const title = guessTitle(rawText);
  if (title) return titlesRoughlyEqual(s2.title, title);
  const surname = s2.authors?.[0]?.name?.trim().split(/\s+/).at(-1);
  if (!surname || !s2.year) return false;
  return (
    rawText.toLowerCase().includes(surname.toLowerCase()) && rawText.includes(String(s2.year))
  );
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage full/unavailable; caching is a nice-to-have, not required
  }
}
