import { fetchJson } from "../net/fetchJson";
import { createThrottledQueue } from "../net/throttle";
import { resolveKnownPaperPdfUrl } from "../pdfSources";
import type { ResolvedPaper } from "../types";
import { arxivIdFromDoi } from "./identifiers";
import { MAILTO } from "./politeness";
import { titlesRoughlyEqual } from "./titleMatch";

const BASE = "https://api.crossref.org";
const WORK_SELECT = "title,author,DOI,issued,container-title,URL,abstract";

// Crossref's polite pool tolerates ~50 req/s; 100ms spacing is ample.
const throttled = createThrottledQueue(100);

export interface CrossrefWork {
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  DOI?: string;
  issued?: { "date-parts"?: Array<Array<number | null>> };
  "container-title"?: string[];
  URL?: string;
  /** JATS XML when present ("<jats:p>…</jats:p>"). */
  abstract?: string;
}

export async function getCrossrefWorkByDoi(doi: string): Promise<CrossrefWork | null> {
  const res = await throttled(() =>
    fetchJson<{ message?: CrossrefWork }>(
      `${BASE}/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`,
    ),
  );
  return res.ok ? res.data?.message ?? null : null;
}

/**
 * Matches a raw bibliography entry via Crossref's `query.bibliographic`,
 * which is built for whole citation strings — no title extraction needed.
 * Crossref always returns *something*, so a hit only counts when it passes
 * `crossrefMatchLooksRight` against the reference text.
 */
export async function matchCrossrefBibliographic(
  rawText: string,
  guessedTitle: string | null,
): Promise<CrossrefWork | null> {
  const query = cleanBibliographicQuery(rawText);
  if (query.length < 8) return null;
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "3",
    select: WORK_SELECT,
    mailto: MAILTO,
  });
  const res = await throttled(() =>
    fetchJson<{ message?: { items?: CrossrefWork[] } }>(`${BASE}/works?${params}`),
  );
  if (!res.ok) return null;
  const items = res.data?.message?.items ?? [];
  return items.find((item) => crossrefMatchLooksRight(item, rawText, guessedTitle)) ?? null;
}

/**
 * Guards against Crossref's always-answers behavior. With an extracted title
 * the check is a near-exact title match; without one, the hit's first-author
 * surname and year must both literally appear in the reference text.
 */
export function crossrefMatchLooksRight(
  work: CrossrefWork,
  rawText: string,
  guessedTitle: string | null,
): boolean {
  const title = work.title?.[0];
  if (!title) return false;
  if (guessedTitle) return titlesRoughlyEqual(title, guessedTitle);

  const surname = work.author?.[0]?.family;
  const year = work.issued?.["date-parts"]?.[0]?.[0];
  if (!surname || !year) return false;
  return (
    rawText.toLowerCase().includes(surname.toLowerCase()) && rawText.includes(String(year))
  );
}

export function crossrefWorkToResolvedPaper(work: CrossrefWork): ResolvedPaper | null {
  const title = work.title?.[0]?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  const doi = work.DOI;
  const arxivId = doi ? arxivIdFromDoi(doi) : null;
  const pageUrl = work.URL ?? (doi ? `https://doi.org/${doi}` : undefined);
  const knownPdfUrl = pageUrl ? resolveKnownPaperPdfUrl(pageUrl) ?? undefined : undefined;
  const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : knownPdfUrl;
  return {
    title,
    abstract: stripJats(work.abstract),
    authors: (work.author ?? [])
      .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" "))
      .filter(Boolean),
    authorProfiles: (work.author ?? [])
      .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" "))
      .filter(Boolean)
      .map((name) => ({ name, paperHint: { doi, title } })),
    year: work.issued?.["date-parts"]?.[0]?.[0] ?? undefined,
    venue: work["container-title"]?.[0] ?? undefined,
    doi,
    pdfUrl,
    pageUrl,
    source: arxivId ? "arxiv" : pdfUrl ? "direct-pdf" : pageUrl ? "page" : "none",
  };
}

function stripJats(abstract: string | undefined): string | undefined {
  if (!abstract) return undefined;
  const text = abstract
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function cleanBibliographicQuery(rawText: string): string {
  return rawText
    .replace(/^\[\d+\]\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
