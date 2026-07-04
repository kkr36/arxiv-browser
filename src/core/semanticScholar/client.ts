import { fetchJson, type JsonResponse } from "../net/fetchJson";

export interface S2Author {
  name: string;
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

interface S2SearchResponse {
  data?: S2Paper[];
}

const BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "title,abstract,authors,year,venue,url,externalIds,openAccessPdf";

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

function cleanQuery(rawText: string): string {
  return rawText
    .replace(/^\[\d+\]\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .slice(0, 300);
}

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

// The author block at the head of an initials-style reference: repeated
// "Surname, I. J.," (optionally with lowercase particles and "and"/"&"),
// ending where the title's first word begins. Unicode classes so accented
// names (Gallé, Trhlík) don't break the run.
const PARTICLES = String.raw`(?:(?:van|von|der|den|de|del|della|da|di|dos|du|la|le|el|ter|ten|al)\s+)*`;
const NAME_WORD = String.raw`\p{Lu}[\p{L}'’-]+`;
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
  const block = text.match(AUTHOR_BLOCK_RE);
  const afterAuthors = block && block[0].length >= 8 ? text.slice(block[0].length) : null;

  let candidate: string;
  if (afterAuthors !== null) {
    candidate = afterAuthors;
  } else {
    const segments = text.split(SENTENCE_SPLIT_RE);
    candidate = segments.length > 1 ? segments[1] : segments[0];
  }
  // Author-year styles put the year before the title: "…Polosukhin. 2017. Title…"
  candidate = candidate.trim().replace(/^(19|20)\d{2}[a-z]?\.\s*/, "");
  candidate = candidate.split(SENTENCE_SPLIT_RE)[0].trim();
  const venue = candidate.match(TRAILING_VENUE_RE);
  if (venue && venue.index !== undefined) candidate = candidate.slice(0, venue.index);
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
