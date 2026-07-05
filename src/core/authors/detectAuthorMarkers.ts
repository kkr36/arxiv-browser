import type { AuthorMarker, AuthorProfileRef, PageText } from "../types";

const MAX_AUTHOR_PAGES = 2;

export function detectAuthorMarkers(
  pages: PageText[],
  authors: AuthorProfileRef[],
): Map<number, AuthorMarker[]> {
  const markersByPage = new Map<number, AuthorMarker[]>();
  const uniqueAuthors = dedupeAuthors(authors).filter((author) => author.name.length >= 4);
  if (uniqueAuthors.length === 0) return markersByPage;

  for (const page of pages.slice(0, MAX_AUTHOR_PAGES)) {
    const searchableEnd = firstSectionOffset(page.text);
    const pageMarkers: AuthorMarker[] = [];
    for (const author of uniqueAuthors) {
      for (const range of findNameRanges(page.text.slice(0, searchableEnd), author.name)) {
        pageMarkers.push({
          id: `author:${page.pageNumber}:${range.start}:${slug(author.name)}`,
          page: page.pageNumber,
          start: range.start,
          end: range.end,
          raw: page.text.slice(range.start, range.end),
          author,
        });
      }
    }
    if (pageMarkers.length > 0) {
      markersByPage.set(
        page.pageNumber,
        pageMarkers.sort((a, b) => a.start - b.start || b.end - a.end),
      );
    }
  }

  return markersByPage;
}

function findNameRanges(text: string, name: string): Array<{ start: number; end: number }> {
  const escaped = name
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join(String.raw`\s+`);
  const re = new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, "giu");
  return [...text.matchAll(re)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function firstSectionOffset(text: string): number {
  const match = text.match(/\n\s*(abstract|1\.?\s+introduction|introduction)\b/i);
  return match?.index ?? Math.min(text.length, 5000);
}

function dedupeAuthors(authors: AuthorProfileRef[]): AuthorProfileRef[] {
  const seen = new Set<string>();
  const out: AuthorProfileRef[] = [];
  for (const author of authors) {
    const name = author.name.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...author, name });
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
