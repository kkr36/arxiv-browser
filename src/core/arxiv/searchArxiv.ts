import { fetchText } from "../net/fetchJson";
import type { ResolvedPaper } from "../types";

// arXiv's API guidelines ask for ~3s between requests; a serialized queue
// (same pattern as the Semantic Scholar client) keeps concurrent hovers from
// bursting. This path only runs when Semantic Scholar found nothing, so the
// spacing is rarely felt.
const MIN_INTERVAL_MS = 3100;
const API = "https://export.arxiv.org/api/query";

let queueTail: Promise<unknown> = Promise.resolve();
let nextAllowedAt = 0;

function arxivFetch(url: string): Promise<string | null> {
  const run = queueTail.then(async () => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
    return fetchText(url);
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  year?: number;
}

// The Atom feed is machine-generated with a fixed shape, so a light regex
// parse keeps this module free of DOM dependencies (usable in tests/node).
function parseAtomEntries(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const idUrl = tag(block, "id");
    const id = idUrl.match(/arxiv\.org\/abs\/(.+?)(v\d+)?$/)?.[1];
    const title = tag(block, "title").replace(/\s+/g, " ").trim();
    if (!id || !title) continue;
    entries.push({
      id,
      title,
      summary: tag(block, "summary").replace(/\s+/g, " ").trim(),
      authors: [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => decodeEntities(a[1].trim())),
      year: Number(tag(block, "published").slice(0, 4)) || undefined,
    });
  }
  return entries;
}

function tag(block: string, name: string): string {
  return decodeEntities(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function toResolved(e: ArxivEntry): ResolvedPaper {
  return {
    title: e.title,
    abstract: e.summary || undefined,
    authors: e.authors,
    year: e.year,
    pdfUrl: `https://arxiv.org/pdf/${e.id}`,
    source: "arxiv",
  };
}

/** Letters/digits only, lowercase — so hyphenation damage from PDF text
 * extraction ("machinegenerated") still equals the real title. */
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}0-9]+/gu, "");
}

/**
 * Fallback used when Semantic Scholar can't resolve a reference: search the
 * arXiv API by extracted title. Only a (near-)exact title match is accepted —
 * a fuzzy hit here would open the wrong paper.
 */
export async function searchArxivByTitle(title: string): Promise<ResolvedPaper | null> {
  const quoted = `"${title.replace(/"/g, " ")}"`;
  const xml = await arxivFetch(
    `${API}?search_query=ti:${encodeURIComponent(quoted)}&max_results=5`,
  );
  if (!xml) return null;
  const want = normalizeTitle(title);
  for (const entry of parseAtomEntries(xml)) {
    const got = normalizeTitle(entry.title);
    // Exact, or a short prefix difference (a lost subtitle) — a generous
    // prefix rule would conflate "Strategic classification" with
    // "Strategic classification made practical".
    const prefixOk =
      (got.startsWith(want) || want.startsWith(got)) &&
      Math.max(got.length, want.length) <= Math.min(got.length, want.length) * 1.25;
    if (got === want || prefixOk) return toResolved(entry);
  }
  return null;
}

/**
 * Direct arXiv metadata lookup by id — covers references that carry an
 * explicit arXiv id which Semantic Scholar hasn't indexed (yet).
 */
export async function fetchArxivById(arxivId: string): Promise<ResolvedPaper | null> {
  const xml = await arxivFetch(`${API}?id_list=${encodeURIComponent(arxivId)}&max_results=1`);
  if (!xml) return null;
  const entry = parseAtomEntries(xml)[0];
  return entry ? toResolved(entry) : null;
}
