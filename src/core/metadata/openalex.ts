import { fetchJson, type JsonResponse } from "../net/fetchJson";
import { createThrottledQueue } from "../net/throttle";
import { resolveKnownPaperPdfUrl } from "../pdfSources";
import { isLikelyProxyHostilePdfUrl } from "../semanticScholar/resolvePaper";
import type { AuthorWork, ResolvedAuthorPage, ResolvedPaper } from "../types";
import { arxivIdFromDoi } from "./identifiers";
import { MAILTO } from "./politeness";
import { normalizeTitle, titlesRoughlyEqual } from "./titleMatch";

const BASE = "https://api.openalex.org";
const WORK_SELECT =
  "id,display_name,doi,publication_year,authorships,primary_location,locations,open_access,abstract_inverted_index,cited_by_count";
const AUTHOR_SELECT = "id,display_name,works_count,cited_by_count,summary_stats";

// OpenAlex allows ~10 req/s on the polite pool; stay comfortably under it.
const throttled = createThrottledQueue(150);

// Routed via the dev proxy (like the Semantic Scholar client) rather than
// fetched directly, even though OpenAlex sends CORS headers and a direct
// fetch would work: an optional OPENALEX_API_KEY lives server-side in
// `.env.local` (raises the free daily budget from $0.10 to $1 — easy to
// exhaust otherwise) and, like the S2 key, must never reach client code, so
// there's no way for this module to know whether one is configured except by
// always asking the proxy to attach it.

export interface OaAuthorship {
  author?: { id?: string | null; display_name?: string | null } | null;
  raw_author_name?: string | null;
}

interface OaLocation {
  pdf_url?: string | null;
  landing_page_url?: string | null;
  source?: { display_name?: string | null } | null;
}

export interface OaWork {
  id?: string;
  display_name?: string | null;
  doi?: string | null;
  publication_year?: number | null;
  authorships?: OaAuthorship[] | null;
  primary_location?: OaLocation | null;
  locations?: OaLocation[] | null;
  open_access?: { oa_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number | null;
}

export interface OaAuthor {
  id?: string;
  display_name?: string | null;
  works_count?: number | null;
  cited_by_count?: number | null;
  summary_stats?: { h_index?: number | null } | null;
}

async function oaGet<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  const res = await oaGetResponse<T>(path, params);
  return res.ok ? res.data : null;
}

async function oaGetResponse<T>(
  path: string,
  params?: Record<string, string>,
): Promise<JsonResponse<T>> {
  const search = new URLSearchParams({ ...params, mailto: MAILTO });
  return throttled(() => fetchJson<T>(`${BASE}${path}?${search}`, { viaProxy: true }));
}

/** OpenAlex entity ids are full URLs ("https://openalex.org/A123"); the API
 * accepts the bare tail, which is also what we persist. */
export function shortOpenAlexId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//i, "");
}

/** Rebuilds abstract text from OpenAlex's inverted index (word → positions). */
export function abstractFromInvertedIndex(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text || undefined;
}

export function arxivIdFromOaWork(work: OaWork): string | null {
  const doi = doiFromOaWork(work);
  if (doi) {
    const fromDoi = arxivIdFromDoi(doi);
    if (fromDoi) return fromDoi;
  }
  for (const location of allLocations(work)) {
    for (const url of [location.pdf_url, location.landing_page_url]) {
      const m = url?.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:v\d+)?$/i);
      if (m) return m[1];
    }
  }
  return null;
}

function doiFromOaWork(work: OaWork): string | undefined {
  return work.doi?.replace(/^https?:\/\/doi\.org\//i, "") || undefined;
}

function allLocations(work: OaWork): OaLocation[] {
  const locations = [work.primary_location, ...(work.locations ?? [])];
  return locations.filter((l): l is OaLocation => !!l);
}

function bestPdfUrl(work: OaWork): string | undefined {
  const arxivId = arxivIdFromOaWork(work);
  if (arxivId) return `https://arxiv.org/pdf/${arxivId}.pdf`;
  const locations = allLocations(work);
  const knownSourceCandidates = [
    work.open_access?.oa_url,
    ...locations.flatMap((l) => [l.pdf_url, l.landing_page_url]),
  ]
    .map((u) => (u ? resolveKnownPaperPdfUrl(u) : null))
    .filter((u): u is string => !!u);
  const knownSourcePdf = knownSourceCandidates.find((u) => !isLikelyProxyHostilePdfUrl(u));
  if (knownSourcePdf) return knownSourcePdf;

  const candidates = [
    work.open_access?.oa_url,
    ...locations.map((l) => l.pdf_url),
  ].filter((u): u is string => !!u);
  return candidates.find((u) => !isLikelyProxyHostilePdfUrl(u));
}

function pageUrlOf(work: OaWork): string | undefined {
  return (
    work.doi ??
    allLocations(work)
      .map((l) => l.landing_page_url)
      .find((u): u is string => !!u) ??
    work.id ??
    undefined
  );
}

function authorNamesOf(work: OaWork): string[] {
  return (work.authorships ?? [])
    .map((a) => a.author?.display_name || a.raw_author_name || "")
    .filter(Boolean);
}

export function oaWorkToResolvedPaper(work: OaWork): ResolvedPaper | null {
  const title = work.display_name?.trim();
  if (!title) return null;
  const doi = doiFromOaWork(work);
  const arxivId = arxivIdFromOaWork(work) ?? undefined;
  const pdfUrl = bestPdfUrl(work);
  const pageUrl = pageUrlOf(work);
  return {
    title,
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    authors: authorNamesOf(work),
    authorProfiles: (work.authorships ?? [])
      .filter((a) => a.author?.display_name || a.raw_author_name)
      .map((a) => ({
        name: (a.author?.display_name || a.raw_author_name)!,
        openAlexAuthorId: a.author?.id ? shortOpenAlexId(a.author.id) : undefined,
        paperHint: { doi, arxivId, title },
      })),
    year: work.publication_year ?? undefined,
    venue: work.primary_location?.source?.display_name ?? undefined,
    doi,
    pdfUrl,
    pageUrl,
    source: arxivId ? "arxiv" : pdfUrl ? "direct-pdf" : pageUrl ? "page" : "none",
  };
}

export function oaWorkToAuthorWork(work: OaWork): AuthorWork | null {
  const paper = oaWorkToResolvedPaper(work);
  if (!paper) return null;
  return {
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    pdfUrl: paper.pdfUrl,
    pageUrl: paper.pageUrl,
  };
}

/**
 * OpenAlex contains duplicate work records (preprint mirrors, versioned
 * uploads) that fragment an author's list; collapse them by normalized title,
 * letting later duplicates fill fields the kept record is missing.
 */
export function dedupeAuthorWorks(works: AuthorWork[]): AuthorWork[] {
  const byTitle = new Map<string, AuthorWork>();
  const out: AuthorWork[] = [];
  for (const work of works) {
    const key = normalizeTitle(work.title);
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, work);
      out.push(work);
      continue;
    }
    existing.authors = existing.authors?.length ? existing.authors : work.authors;
    existing.year = existing.year ?? work.year;
    existing.venue = existing.venue ?? work.venue;
    existing.abstract = existing.abstract ?? work.abstract;
    existing.pdfUrl = existing.pdfUrl ?? work.pdfUrl;
    existing.pageUrl = existing.pageUrl ?? work.pageUrl;
  }
  return out;
}

export async function getOaWorkByDoi(doi: string): Promise<OaWork | null> {
  return oaGet<OaWork>(`/works/doi:${encodeURIComponent(doi)}`, { select: WORK_SELECT });
}

export async function getOaWorkByArxivId(arxivId: string): Promise<OaWork | null> {
  return getOaWorkByDoi(`10.48550/arxiv.${arxivId}`);
}

async function searchOaWorks(
  params: Record<string, string>,
): Promise<OaWork[]> {
  const data = await oaGet<{ results?: OaWork[] }>("/works", {
    ...params,
    "per-page": "5",
    select: WORK_SELECT,
  });
  return data?.results ?? [];
}

/**
 * Title-filtered work search; only a (near-)exact title match is accepted —
 * a fuzzy hit here would open the wrong paper. OpenAlex frequently splits a
 * paper's arXiv preprint and its published version into two separate work
 * records with an identical title (e.g. an OpenReview-hosted ICLR paper and
 * its arXiv mirror); relevance-ranking alone can put the non-PDF venue
 * record first, so among title matches the one with a usable PDF wins —
 * arXiv preferred.
 */
export async function matchOaWorkByTitle(title: string): Promise<OaWork | null> {
  const works = (await searchOaWorks({ filter: `title.search:${quoteSearch(title)}` })).filter(
    (w) => w.display_name && titlesRoughlyEqual(w.display_name, title),
  );
  if (works.length === 0) return null;
  const rank = (w: OaWork) => (arxivIdFromOaWork(w) ? 2 : bestPdfUrl(w) ? 1 : 0);
  return works.reduce((best, w) => (rank(w) > rank(best) ? w : best));
}

// OpenAlex filter values treat commas as OR separators; a quoted phrase
// keeps multi-word titles intact.
function quoteSearch(s: string): string {
  return `"${s.replace(/"/g, " ").trim()}"`;
}

/** Case/diacritic-insensitive person-name key ("José Álvarez" → "jose alvarez"). */
export function normalizePersonName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether an authorship's name refers to `name`. Exact normalized match, or
 * same surname plus same first initial — bibliographies abbreviate given
 * names ("N. Garg") while OpenAlex stores them in full.
 */
export function authorshipMatchesName(authorship: OaAuthorship, name: string): boolean {
  const candidate = authorship.author?.display_name || authorship.raw_author_name;
  if (!candidate) return false;
  const a = normalizePersonName(candidate);
  const b = normalizePersonName(name);
  if (!a || !b) return false;
  if (a === b) return true;
  const [aParts, bParts] = [a.split(" "), b.split(" ")];
  const [aSurname, bSurname] = [aParts.at(-1), bParts.at(-1)];
  return (
    aSurname === bSurname &&
    aParts[0]?.[0] === bParts[0]?.[0] &&
    aParts.length > 0 &&
    bParts.length > 0
  );
}

export interface PaperHint {
  doi?: string;
  arxivId?: string;
  title?: string;
}

/**
 * Resolves an author to an OpenAlex id *through a paper they appear on* —
 * the only reliable disambiguation route. Name search on every scholarly
 * service ranks by prominence, so a plain "Nikhil Garg" query returns
 * whichever namesake has the most citations; the authorship row on a known
 * work pins the right person exactly.
 */
export async function findOaAuthorIdViaWork(
  name: string,
  hint: PaperHint,
): Promise<string | null> {
  let work: OaWork | null = null;
  if (hint.doi) work = await getOaWorkByDoi(hint.doi);
  if (!work && hint.arxivId) work = await getOaWorkByArxivId(hint.arxivId);
  if (!work && hint.title) work = await matchOaWorkByTitle(hint.title);
  if (!work) return null;
  const authorship = (work.authorships ?? []).find((a) => authorshipMatchesName(a, name));
  return authorship?.author?.id ? shortOpenAlexId(authorship.author.id) : null;
}

/**
 * Name-search fallback when no paper context exists. Only an exact
 * normalized-name match is accepted (the most published one when several
 * share the name); a looser rule would hand back a namesake.
 */
export async function searchOaAuthorByName(name: string): Promise<OaAuthor | null> {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length < 3) return null;
  const data = await oaGet<{ results?: OaAuthor[] }>("/authors", {
    search: clean,
    "per-page": "10",
    select: AUTHOR_SELECT,
  });
  const wanted = normalizePersonName(clean);
  const exact = (data?.results ?? []).filter(
    (a) => a.display_name && normalizePersonName(a.display_name) === wanted,
  );
  if (exact.length === 0) return null;
  return exact.reduce((best, a) => ((a.works_count ?? 0) > (best.works_count ?? 0) ? a : best));
}

export async function getOaAuthorPage(authorId: string): Promise<ResolvedAuthorPage | null> {
  const id = shortOpenAlexId(authorId);
  const author = await oaGet<OaAuthor>(`/authors/${encodeURIComponent(id)}`, {
    select: AUTHOR_SELECT,
  });
  if (!author?.display_name) return null;

  const worksResponse = await getOaAuthorWorks(id);
  const works = dedupeAuthorWorks(
    (worksResponse.data?.results ?? [])
      .map(oaWorkToAuthorWork)
      .filter((w): w is AuthorWork => !!w),
  );
  const worksLoadError = worksResponse.ok
    ? works.length === 0 && (author.works_count ?? 0) > 0
      ? "OpenAlex returned an empty works list even though this author profile has a nonzero works count."
      : undefined
    : openAlexWorksError(worksResponse);
  const url = `https://openalex.org/authors/${id}`;
  return {
    id: `openalex-author:${id}`,
    name: author.display_name,
    source: "openalex",
    url,
    openAlexUrl: url,
    paperCount: author.works_count ?? undefined,
    citationCount: author.cited_by_count ?? undefined,
    hIndex: author.summary_stats?.h_index ?? undefined,
    worksLoadError,
    worksRetryAfterMs: worksResponse.ok ? undefined : worksResponse.retryAfterMs,
    works,
  };
}

async function getOaAuthorWorks(id: string): Promise<JsonResponse<{ results?: OaWork[] }>> {
  const params = {
    filter: `author.id:${id}`,
    sort: "cited_by_count:desc",
    "per-page": "100",
    select: WORK_SELECT,
  };
  const response = await oaGetResponse<{ results?: OaWork[] }>("/works", params);
  if (!response.ok || (response.data?.results?.length ?? 0) > 0) return response;

  return oaGetResponse<{ results?: OaWork[] }>("/works", {
    ...params,
    filter: `authorships.author.id:${id}`,
  });
}

function openAlexWorksError(response: JsonResponse<unknown>): string {
  if (response.status === 429) {
    const retry = response.retryAfterMs
      ? ` Try again in about ${Math.ceil(response.retryAfterMs / 1000)} seconds.`
      : "";
    return `OpenAlex rate-limited the works request.${retry}`;
  }
  return `OpenAlex returned HTTP ${response.status} while loading this author's works.`;
}
