import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { extractAllPageText } from "./pdf/extractText";
import { parseBibliography } from "./citations/parseBibliography";
import { detectMarkersOnPage, type ExcludedRange } from "./citations/detectMarkers";
import { matchMarkersToEntries } from "./citations/matchMarkersToEntries";
import {
  extractArxivId,
  guessTitle,
  matchPaperByReferenceText,
} from "./semanticScholar/client";
import { isLikelyProxyHostilePdfUrl, toResolvedPaper } from "./semanticScholar/resolvePaper";
import { fetchArxivById, searchArxivByTitle } from "./arxiv/searchArxiv";
import type { BibEntry, CitationMarker, PageText, ResolvedPaper } from "./types";

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
    // v4: bumped when the resolution pipeline improved, so stale results
    // cached by the old (title-guess-only) logic get re-resolved.
    const cacheKey = `arxiv-browser:s2v4:${entry.rawText.slice(0, 120)}`;
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
 * Semantic Scholar first (richest metadata, handles explicit arXiv ids/DOIs
 * itself); when it comes up empty, back off to the arXiv API — by explicit
 * id when the reference names one, else by extracted title.
 */
async function resolveRawReference(rawText: string): Promise<ResolvedPaper | null> {
  const s2 = await matchPaperByReferenceText(rawText);
  if (s2) {
    const resolved = toResolvedPaper(s2);
    const directPdf = s2.openAccessPdf?.url;
    if (
      directPdf &&
      isLikelyProxyHostilePdfUrl(directPdf) &&
      resolved.source !== "arxiv"
    ) {
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
  return title ? searchArxivByTitle(title) : null;
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
