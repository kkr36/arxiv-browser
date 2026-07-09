import { fetchText } from "../net/fetchJson";
import type { AuthorProfileRef, AuthorWork, ResolvedAuthorPage } from "../types";
import {
  getAuthorById,
  searchAuthorByName,
  type S2AuthorProfile,
  type S2Paper,
} from "../semanticScholar/client";
import { toResolvedPaper } from "../semanticScholar/resolvePaper";
import {
  findOaAuthorIdViaWork,
  getOaAuthorPage,
  searchOaAuthorByName,
  shortOpenAlexId,
} from "../metadata/openalex";

export function looksLikeAuthorUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (
      isGoogleScholarProfile(url) ||
      parseSemanticScholarAuthorId(url) !== null ||
      parseOpenAlexAuthorId(url) !== null
    );
  } catch {
    return false;
  }
}

export async function resolveAuthorInput(raw: string): Promise<ResolvedAuthorPage> {
  const input = raw.trim();
  const url = new URL(input);
  const oaId = parseOpenAlexAuthorId(url);
  if (oaId) {
    const author = await getOaAuthorPage(oaId);
    if (!author) throw new Error("OpenAlex did not find that author.");
    return author;
  }

  const s2Id = parseSemanticScholarAuthorId(url);
  if (s2Id) {
    const author = await getAuthorById(s2Id);
    if (!author) throw new Error("Semantic Scholar did not find that author.");
    return authorPageFromS2(author);
  }

  if (isGoogleScholarProfile(url)) {
    const scholar = await resolveGoogleScholarProfile(url.toString());
    const fallback = scholar.name
      ? await resolveByNameSearch(scholar.name).catch(() => null)
      : null;
    if (fallback?.works.length) {
      return {
        ...fallback,
        id: `scholar:${googleScholarUserId(url) ?? scholar.url}`,
        source: "google-scholar",
        googleScholarUrl: scholar.url,
        url: scholar.url,
        works: mergeWorks(scholar.works, fallback.works),
      };
    }
    return scholar;
  }

  throw new Error(
    "Enter a Google Scholar, OpenAlex, or Semantic Scholar author profile URL.",
  );
}

/**
 * Resolution order favors precision over recall: explicit ids first, then
 * disambiguation through a paper the author is known to appear on (name
 * search on any scholarly service ranks namesakes by prominence, which is
 * how author pages end up wrong), and name search only as a last resort.
 */
export async function resolveAuthorRef(ref: AuthorProfileRef): Promise<ResolvedAuthorPage> {
  const override = KNOWN_AUTHOR_OVERRIDES.get(normalizeLookupName(ref.name));
  if (override) {
    const author = await getAuthorById(override.semanticScholarAuthorId);
    if (author) return authorPageFromS2(author);
    return {
      id: `s2-author:${override.semanticScholarAuthorId}`,
      name: ref.name,
      source: "semantic-scholar",
      semanticScholarUrl: override.semanticScholarUrl,
      works: [],
    };
  }

  if (ref.openAlexAuthorId) {
    const author = await getOaAuthorPage(ref.openAlexAuthorId);
    if (author) return author;
  }
  if (ref.semanticScholarAuthorId) {
    const author = await getAuthorById(ref.semanticScholarAuthorId);
    if (author) return authorPageFromS2(author);
  }
  if (ref.semanticScholarUrl) {
    const id = parseSemanticScholarAuthorId(new URL(ref.semanticScholarUrl));
    if (id) {
      const author = await getAuthorById(id);
      if (author) return authorPageFromS2(author);
    }
  }
  if (ref.googleScholarUrl) return resolveAuthorInput(ref.googleScholarUrl);

  if (ref.paperHint) {
    const viaWork = await findOaAuthorIdViaWork(ref.name, ref.paperHint).catch(() => null);
    if (viaWork) {
      const author = await getOaAuthorPage(viaWork);
      if (author) return author;
    }
  }

  const byName = await resolveByNameSearch(ref.name).catch(() => null);
  if (byName) return byName;

  return {
    id: `author:${ref.name.toLowerCase()}`,
    name: ref.name,
    source: "openalex",
    works: [],
  };
}

/** Exact-name OpenAlex search, then Semantic Scholar as the final fallback. */
async function resolveByNameSearch(name: string): Promise<ResolvedAuthorPage | null> {
  const oaAuthor = await searchOaAuthorByName(name).catch(() => null);
  if (oaAuthor?.id) {
    const page = await getOaAuthorPage(shortOpenAlexId(oaAuthor.id));
    if (page) return page;
  }
  const s2Author = await searchAuthorByName(name).catch(() => null);
  return s2Author ? authorPageFromS2(s2Author) : null;
}

const KNOWN_AUTHOR_OVERRIDES = new Map([
  [
    "kevin ren",
    {
      semanticScholarAuthorId: "2310234614",
      semanticScholarUrl: "https://www.semanticscholar.org/author/Kevin-Ren/2310234614",
    },
  ],
  [
    "nikhil garg",
    {
      semanticScholarAuthorId: "2779427",
      semanticScholarUrl: "https://www.semanticscholar.org/author/Nikhil-Garg/2779427",
    },
  ],
]);

function normalizeLookupName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function paperFromAuthorWork(work: AuthorWork) {
  return {
    title: work.title,
    abstract: work.abstract,
    authors: work.authors ?? [],
    year: work.year,
    venue: work.venue,
    pdfUrl: work.pdfUrl,
    pageUrl: work.pageUrl,
    semanticScholarUrl: work.semanticScholarUrl,
    source: work.pdfUrl
      ? work.pdfUrl.includes("arxiv.org/pdf/")
        ? "arxiv"
        : "direct-pdf"
      : work.pageUrl
        ? "page"
        : work.semanticScholarUrl
          ? "semantic-scholar-page"
          : "none",
  } as const;
}

export function authorPageFromS2(author: S2AuthorProfile): ResolvedAuthorPage {
  return {
    id: `s2-author:${author.authorId}`,
    name: author.name,
    source: "semantic-scholar",
    url: author.url,
    semanticScholarUrl: author.url,
    homepage: author.homepage ?? undefined,
    paperCount: author.paperCount ?? undefined,
    citationCount: author.citationCount ?? undefined,
    hIndex: author.hIndex ?? undefined,
    works: (author.papers ?? []).map(workFromS2Paper).filter((w) => w.title),
  };
}

function workFromS2Paper(paper: S2Paper): AuthorWork {
  const resolved = toResolvedPaper(paper);
  return {
    title: resolved.title,
    abstract: resolved.abstract,
    authors: resolved.authors,
    year: resolved.year,
    venue: resolved.venue,
    pdfUrl: resolved.pdfUrl,
    semanticScholarUrl: resolved.semanticScholarUrl,
  };
}

async function resolveGoogleScholarProfile(url: string): Promise<ResolvedAuthorPage> {
  const html = await fetchText(url);
  if (!html) {
    throw new Error(
      "Could not read that Google Scholar profile. Try the matching Semantic Scholar author page.",
    );
  }

  const name = textFromFirstMatch(html, /<div[^>]+id=["']gsc_prf_in["'][^>]*>([\s\S]*?)<\/div>/i);
  const works = [...html.matchAll(/<tr[^>]+class=["'][^"']*gsc_a_tr[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => parseScholarWork(match[1]))
    .filter((work): work is AuthorWork => !!work);

  if (!name && works.length === 0) {
    throw new Error(
      "Google Scholar did not return a readable profile. Try the matching Semantic Scholar author page.",
    );
  }

  return {
    id: `scholar:${googleScholarUserId(new URL(url)) ?? url}`,
    name: name ?? "Google Scholar author",
    source: "google-scholar",
    url,
    googleScholarUrl: url,
    works,
  };
}

function parseScholarWork(rowHtml: string): AuthorWork | null {
  const title = textFromFirstMatch(rowHtml, /<a[^>]+class=["'][^"']*gsc_a_at[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!title) return null;
  const cells = [...rowHtml.matchAll(/<div[^>]+class=["'][^"']*gs_gray[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].map(
    (m) => cleanHtmlText(m[1]),
  );
  const year = Number(textFromFirstMatch(rowHtml, /<span[^>]+class=["']gsc_a_h["'][^>]*>(\d{4})<\/span>/i));
  return {
    title,
    authors: cells[0] ? cells[0].split(/\s*,\s*/).filter(Boolean) : undefined,
    venue: cells[1] || undefined,
    year: Number.isFinite(year) ? year : undefined,
    rawText: [cells[0], title, cells[1], Number.isFinite(year) ? String(year) : ""]
      .filter(Boolean)
      .join(". "),
  };
}

function isGoogleScholarProfile(url: URL): boolean {
  return url.hostname.includes("scholar.google.") && url.pathname.includes("/citations");
}

function googleScholarUserId(url: URL): string | null {
  return url.searchParams.get("user");
}

function parseSemanticScholarAuthorId(url: URL): string | null {
  if (!url.hostname.endsWith("semanticscholar.org")) return null;
  const match = url.pathname.match(/\/author\/(?:[^/]+\/)?(\d+)/i);
  return match?.[1] ?? null;
}

function parseOpenAlexAuthorId(url: URL): string | null {
  if (!url.hostname.replace(/^www\./, "").endsWith("openalex.org")) return null;
  const match = url.pathname.match(/^\/(?:authors\/)?(A\d+)\/?$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function textFromFirstMatch(html: string, re: RegExp): string | null {
  const match = html.match(re);
  return match ? cleanHtmlText(match[1]) : null;
}

function cleanHtmlText(html: string): string {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function mergeWorks(primary: AuthorWork[], fallback: AuthorWork[]): AuthorWork[] {
  const byTitle = new Map<string, AuthorWork>();
  const out: AuthorWork[] = [];
  for (const work of primary) {
    const key = work.title.toLowerCase();
    byTitle.set(key, work);
    out.push(work);
  }
  for (const work of fallback) {
    const key = work.title.toLowerCase();
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, work);
      out.push(work);
      continue;
    }
    Object.assign(existing, {
      authors: existing.authors?.length ? existing.authors : work.authors,
      year: existing.year ?? work.year,
      venue: existing.venue ?? work.venue,
      abstract: existing.abstract ?? work.abstract,
      pdfUrl: existing.pdfUrl ?? work.pdfUrl,
      pageUrl: existing.pageUrl ?? work.pageUrl,
      semanticScholarUrl: existing.semanticScholarUrl ?? work.semanticScholarUrl,
      rawText: existing.rawText ?? work.rawText,
    });
  }
  return out;
}
