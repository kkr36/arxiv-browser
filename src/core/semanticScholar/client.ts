import { fetchJson, type JsonResponse } from "../net/fetchJson";
import { extractArxivId, extractDoi } from "../metadata/identifiers";

export interface S2Author {
  name: string;
  authorId?: string;
  url?: string;
}

export interface S2Paper {
  title: string;
  abstract?: string | null;
  authors?: S2Author[];
  year?: number | null;
  venue?: string | null;
  url?: string;
  externalIds?: { ArXiv?: string; DOI?: string };
  openAccessPdf?: { url: string } | null;
}

export interface S2AuthorProfile {
  authorId: string;
  name: string;
  url?: string;
  homepage?: string | null;
  paperCount?: number | null;
  citationCount?: number | null;
  hIndex?: number | null;
  papers?: S2Paper[];
}

interface S2SearchResponse {
  data?: S2Paper[];
}

interface S2AuthorSearchResponse {
  data?: S2AuthorProfile[];
}

const BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "title,abstract,authors,year,venue,url,externalIds,openAccessPdf";
const AUTHOR_FIELDS =
  "authorId,name,url,homepage,paperCount,citationCount,hIndex,papers.title,papers.abstract,papers.authors,papers.year,papers.venue,papers.url,papers.externalIds,papers.openAccessPdf";

/** Thrown when Semantic Scholar keeps returning 429 after retries. */
export class S2RateLimitError extends Error {
  constructor() {
    super("Semantic Scholar is rate-limiting requests — try again in a moment.");
    this.name = "S2RateLimitError";
  }
}

// All Semantic Scholar calls go through one serialized queue with a minimum
// spacing between requests, sized for the 1 request/second budget of an
// authenticated API key (and politeness on the shared unauthenticated pool).
// 429s are retried inside the queue slot — honoring Retry-After when sent —
// so concurrent hovers can never burst past the limit.
const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 3;

let queueTail: Promise<unknown> = Promise.resolve();
let nextAllowedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function s2Fetch<T>(url: string): Promise<JsonResponse<T>> {
  const run = queueTail.then(async () => {
    for (let attempt = 1; ; attempt++) {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Date.now() + MIN_INTERVAL_MS;

      const res = await fetchJson<T>(url, { viaProxy: true });
      if (res.status !== 429) return res;
      if (attempt >= MAX_ATTEMPTS) throw new S2RateLimitError();
      nextAllowedAt = Date.now() + (res.retryAfterMs ?? attempt * 2000);
    }
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Looks up a paper directly by its arXiv id — for papers the user opened
 * from the address bar, where there's no reference text to match against.
 */
export async function getPaperByArxivId(arxivId: string): Promise<S2Paper | null> {
  const res = await s2Fetch<S2Paper>(`${BASE}/paper/arXiv:${arxivId}?fields=${FIELDS}`);
  return res.data?.title ? res.data : null;
}

export async function getPaperByDoi(doi: string): Promise<S2Paper | null> {
  const res = await s2Fetch<S2Paper>(`${BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`);
  return res.data?.title ? res.data : null;
}

export async function getAuthorById(authorId: string): Promise<S2AuthorProfile | null> {
  const res = await s2Fetch<S2AuthorProfile>(
    `${BASE}/author/${encodeURIComponent(authorId)}?fields=${AUTHOR_FIELDS}`,
  );
  return res.data?.name ? res.data : null;
}

export async function searchAuthorByName(name: string): Promise<S2AuthorProfile | null> {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length < 3) return null;
  const res = await s2Fetch<S2AuthorSearchResponse>(
    `${BASE}/author/search?query=${encodeURIComponent(clean)}&limit=1&fields=authorId,name,url,paperCount,citationCount,hIndex`,
  );
  const author = res.data?.data?.[0];
  return author?.authorId ? getAuthorById(author.authorId) : author ?? null;
}

function cleanQuery(rawText: string): string {
  return rawText
    .replace(/^\[\d+\]\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .slice(0, 300);
}

export { extractArxivId, extractDoi } from "../metadata/identifiers";

// The author block at the head of an initials-style reference: repeated
// "Surname, I. J.," (optionally with lowercase particles and "and"/"&"),
// ending where the title's first word begins. Unicode classes so accented
// names (Gallé, Trhlík) don't break the run.
const PARTICLES = String.raw`(?:(?:van|von|der|den|de|del|della|da|di|dos|du|la|le|el|ter|ten|al)\s+)*`;
const NAME_WORD = String.raw`\p{Lu}[\p{L}\p{M}'’-]+`;
const SURNAME = String.raw`${PARTICLES}${NAME_WORD}(?:\s+${NAME_WORD})*?`;
const INITIALS = String.raw`(?:\p{Lu}\.[\s-]*)+`;
const ONE_AUTHOR = String.raw`(?:${SURNAME},\s*${INITIALS}|et\s+al\.?)`;
const AUTHOR_SEP = String.raw`(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+)`;
const AUTHOR_BLOCK_RE = new RegExp(`^(?:${ONE_AUTHOR}${AUTHOR_SEP})+`, "u");

// A sentence boundary: a period preceded by a lowercase letter or `)`, so
// author initials and mid-title abbreviations like "A.I." don't split.
const SENTENCE_SPLIT_RE = /(?<=[\p{Ll})])\.\s+/u;

// Trailing venue/link text glued onto a title candidate when the title ends
// in "?" or an abbreviation (no sentence period to split on).
const TRAILING_VENUE_RE = new RegExp(
  [
    String.raw`\s+In\s+[\p{Lu}0-9(“"]`,
    String.raw`\s+arXiv\s+preprint`,
    String.raw`\s+Advances\s+in\s+[Nn]eural\s+[Ii]nformation`,
    String.raw`\s+Proceedings\s+of\s+the\s`,
    String.raw`\s+(?:ACM|IEEE)\s+Transactions`,
    String.raw`\s+URL\s+https?:`,
    String.raw`\s+https?://`,
    String.raw`\s+Available\s+at\s+SSRN`,
    String.raw`\s+Accessed:`,
  ].join("|"),
  "u",
);

const VENUE_SHAPED_RE =
  /^(in\s+(proceedings|findings|the\s|\d|international|advances)|proceedings of|arxiv preprint|advances in neural|https?:|url\s)/i;

// IEEE/Chicago-style entries wrap the title in quotes ("A. Vaswani, N.
// Shazeer, …, “Attention is all you need,” tech. rep., 2017."). Their
// initials-first author lists defeat AUTHOR_BLOCK_RE (which expects
// "Surname, I."), so the quoted span is matched before any block stripping.
const QUOTED_TITLE_RE = /[“"]([^“”"]{4,300})[”"]/u;

const ANY_AUTHOR_YEAR_TITLE_RE =
  /\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s+(.+)|\b(?:19|20)\d{2}[a-z]?\.?\s+(.+)/;
const LEADING_AUTHOR_YEAR_TITLE_RE = /^\s*\(?\s*(?:19|20)\d{2}[a-z]?\s*\)?\.?\s+(.+)/;
const PAREN_YEAR_TITLE_RE = /\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s+(.+)/;
const PARTIAL_AUTHOR_LIST_RE =
  /^\s*(?:and\s+|&\s+|(?:van|von|de|del|da|di|dos|du|la|le|el|ter|ten)\b|[^,]{1,80},\s*(?:\p{Lu}\.|[^\s,]+))/u;

/**
 * Pulls a probable title out of a raw bibliography entry. Two shapes are
 * handled: initials-style author lists ("Garg, S., Wu, Y., and Lipton, Z.
 * Title. Venue, year.") — where the authors end in "I." and sentence-period
 * splitting would land on the venue — by stripping the author block; and
 * given-name style ("Ashish Vaswani, Noam Shazeer. Title. Venue.") by taking
 * the segment after the first sentence period. Returns null when nothing
 * title-shaped is found; the caller falls back to a general search then.
 */
export function guessTitle(rawText: string): string | null {
  const text = rawText.trim();

  const quoted = text
    .match(QUOTED_TITLE_RE)?.[1]
    .replace(/[.,;]\s*$/, "")
    .trim();
  if (
    quoted &&
    quoted.split(/\s+/).length >= 2 &&
    quoted.length >= 12 &&
    !VENUE_SHAPED_RE.test(quoted)
  ) {
    return quoted;
  }

  const block = text.match(AUTHOR_BLOCK_RE);
  const afterAuthors = block && block[0].length >= 8 ? text.slice(block[0].length) : null;
  const partialAuthorYear =
    afterAuthors !== null && PARTIAL_AUTHOR_LIST_RE.test(afterAuthors)
      ? afterAuthors.match(PAREN_YEAR_TITLE_RE)
      : null;
  const wholeTextAuthorYear = afterAuthors === null ? text.match(ANY_AUTHOR_YEAR_TITLE_RE) : null;
  const firstSentenceBoundary = text.match(SENTENCE_SPLIT_RE);
  const authorYearBeforeTitle =
    wholeTextAuthorYear &&
    (!firstSentenceBoundary ||
      (wholeTextAuthorYear.index ?? Infinity) <=
        (firstSentenceBoundary.index ?? 0) + firstSentenceBoundary[0].length);
  const afterYear =
    afterAuthors !== null
      ? (afterAuthors.match(LEADING_AUTHOR_YEAR_TITLE_RE) ?? partialAuthorYear)
      : authorYearBeforeTitle
        ? wholeTextAuthorYear
        : null;

  let candidate: string;
  if (afterYear) {
    candidate = afterYear[1] ?? afterYear[2] ?? "";
  } else if (afterAuthors !== null) {
    candidate = afterAuthors;
  } else {
    const segments = text.split(SENTENCE_SPLIT_RE);
    candidate = segments.length > 1 ? segments[1] : segments[0];
  }
  // Author-year styles put the year before the title: "…Polosukhin. 2017. Title…"
  candidate = candidate
    .trim()
    .replace(/^\(?\s*(?:19|20)\d{2}[a-z]?\s*\)?\.?\s*/, "");
  candidate = candidate.split(SENTENCE_SPLIT_RE)[0].trim();
  const venue = candidate.match(TRAILING_VENUE_RE);
  if (venue && venue.index !== undefined) candidate = candidate.slice(0, venue.index);
  // Web/report references put the year right after the title with no venue in
  // between ("Community Notes: A New Way to Add Context to Posts, 2025.").
  candidate = candidate.replace(/\s*[,;]\s*\(?(?:19|20)\d{2}[a-z]?\)?\s*\.?\s*$/, "");
  candidate = candidate.replace(/[.,;]\s*$/, "").trim();

  if (VENUE_SHAPED_RE.test(candidate)) return null;
  // A stripped author block is strong evidence the next words are the title,
  // so short two-word titles ("Strategic classification") are accepted there.
  const minWords = afterAuthors !== null ? 2 : 3;
  if (
    candidate.split(/\s+/).length >= minWords &&
    candidate.length >= 12 &&
    candidate.length <= 300
  ) {
    return candidate;
  }
  return null;
}

/**
 * Resolves a raw bibliography entry (author list + title + venue, as one
 * blob of text straight from the PDF) to Semantic Scholar metadata. An
 * explicit arXiv id or DOI in the text is authoritative and looked up
 * directly. Otherwise the title-match endpoint is tried with an extracted
 * title — it only accepts titles; sending it the whole entry is a guaranteed
 * miss — then a general search with the full entry text as a last resort.
 */
export async function matchPaperByReferenceText(rawText: string): Promise<S2Paper | null> {
  const arxivId = extractArxivId(rawText);
  if (arxivId) {
    const byId = await getPaperByArxivId(arxivId);
    if (byId) return byId;
  }
  const doi = extractDoi(rawText);
  if (doi) {
    const byDoi = await getPaperByDoi(doi);
    if (byDoi) return byDoi;
  }

  const title = guessTitle(rawText);
  if (title) {
    const matchRes = await s2Fetch<S2SearchResponse>(
      `${BASE}/paper/search/match?query=${encodeURIComponent(title)}&fields=${FIELDS}`,
    );
    const matchBest = matchRes.data?.data?.[0];
    if (matchBest) return matchBest;
  }

  const searchRes = await s2Fetch<S2SearchResponse>(
    `${BASE}/paper/search?query=${encodeURIComponent(cleanQuery(rawText))}&limit=1&fields=${FIELDS}`,
  );
  return searchRes.data?.data?.[0] ?? null;
}
