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

function cleanQuery(rawText: string): string {
  return rawText
    .replace(/^\[\d+\]\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .slice(0, 300);
}

/**
 * Pulls a probable title out of a raw bibliography entry. References mostly
 * read "Authors. Title. Venue, year." — split on sentence periods (a period
 * preceded by a lowercase letter or `)`, so author initials don't split)
 * and take the segment after the authors. Returns null when nothing
 * title-shaped is found; the caller falls back to a general search then.
 */
export function guessTitle(rawText: string): string | null {
  const segments = rawText.split(/(?<=[a-z)])\.\s+/);
  let candidate = (segments.length > 1 ? segments[1] : segments[0]).trim();
  // Author-year styles put the year before the title: "…Polosukhin. 2017. Title…"
  candidate = candidate.replace(/^(19|20)\d{2}[a-z]?\.\s*/, "").trim();
  const words = candidate.split(/\s+/);
  if (words.length >= 3 && candidate.length >= 15 && candidate.length <= 300) {
    return candidate;
  }
  return null;
}

/**
 * Resolves a raw bibliography entry (author list + title + venue, as one
 * blob of text straight from the PDF) to Semantic Scholar metadata. The
 * title-match endpoint only accepts titles — sending it the whole entry is
 * a guaranteed miss — so we try it with an extracted title, then fall back
 * to a general search with the full entry text.
 */
export async function matchPaperByReferenceText(rawText: string): Promise<S2Paper | null> {
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
