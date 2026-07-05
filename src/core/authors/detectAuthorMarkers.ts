import type { AuthorMarker, AuthorProfileRef, PageText } from "../types";
import { buildPageLines } from "../pdf/buildLines";

const MAX_AUTHOR_PAGES = 2;
const MAX_AUTHOR_CANDIDATES = 24;

export function detectAuthorMarkers(
  pages: PageText[],
  authors: AuthorProfileRef[],
): Map<number, AuthorMarker[]> {
  const markersByPage = new Map<number, AuthorMarker[]>();
  const uniqueAuthors = dedupeAuthors([...authors, ...extractAuthorCandidates(pages)]).filter(
    (author) => author.name.length >= 4,
  );
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

export function extractAuthorCandidates(pages: PageText[]): AuthorProfileRef[] {
  const candidates: AuthorProfileRef[] = [];

  for (const page of pages.slice(0, MAX_AUTHOR_PAGES)) {
    const lines = buildPageLines(page);
    const abstractLineIndex = lines.findIndex((line) => /^\s*abstract\b/i.test(line.text));
    const searchLines = lines.slice(0, abstractLineIndex === -1 ? Math.min(lines.length, 80) : abstractLineIndex);
    const emailAnchored = authorsNearEmailLines(searchLines.map((line) => line.text));
    if (emailAnchored.length > 0) {
      candidates.push(...emailAnchored.map((name) => ({ name })));
      continue;
    }
    for (const line of searchLines) {
      for (const name of namesFromLine(line.text)) {
        candidates.push({ name });
        if (candidates.length >= MAX_AUTHOR_CANDIDATES) return dedupeAuthors(candidates);
      }
    }
  }

  return dedupeAuthors(candidates);
}

function authorsNearEmailLines(lines: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\S+@\S+/.test(lines[i])) continue;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const lineNames = namesFromLine(lines[j]);
      if (lineNames.length > 0) {
        names.push(...lineNames);
        break;
      }
    }
  }
  return names;
}

function namesFromLine(line: string): string[] {
  const cleaned = cleanAuthorLine(line);
  if (!cleaned || rejectAuthorLine(cleaned)) return [];

  const parts = cleaned
    .split(/\s*(?:,|;|\band\b|&|\u00b7|\|)\s*/iu)
    .map((part) => normalizeAuthorName(part))
    .filter(Boolean);
  if (parts.length > 1) return parts.filter(isLikelyPersonName);

  const single = normalizeAuthorName(cleaned);
  return single && isLikelyPersonName(single) ? [single] : [];
}

function cleanAuthorLine(line: string): string {
  return line
    .replace(/\S+@\S+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[*†‡§¶#]+/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAuthorName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{M}.'’\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rejectAuthorLine(line: string): boolean {
  if (line.length < 5 || line.length > 120) return true;
  if (/@/.test(line)) return true;
  if (/\b(abstract|introduction|keywords|appendix|references|proceedings|preprint|arxiv)\b/i.test(line)) return true;
  if (/\b(university|institute|department|school|college|laboratory|labs?|research|brain|google|facebook|meta|microsoft|openai|deepmind|stanford|mit|berkeley|carnegie|cornell|tech|mail|gmail)\b/i.test(line)) return true;
  if (line.split(/\s+/).length > 12) return true;
  return false;
}

function isLikelyPersonName(name: string): boolean {
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  const nameTokens = tokens.filter((token) => {
    if (/^[\p{Lu}]\.?$/u.test(token)) return true;
    return /^[\p{Lu}][\p{L}\p{M}'’.-]+$/u.test(token);
  });
  if (nameTokens.length < 2) return false;
  if (tokens.some((token) => /^[a-z]/.test(token))) return false;
  if (tokens.some((token) => COMMON_NON_NAME_WORDS.has(token.toLowerCase()))) return false;
  return true;
}

const COMMON_NON_NAME_WORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "continual",
  "detection",
  "distribution",
  "attention",
  "based",
  "deep",
  "for",
  "from",
  "in",
  "is",
  "learning",
  "model",
  "models",
  "moving",
  "need",
  "network",
  "networks",
  "neural",
  "of",
  "on",
  "the",
  "to",
  "target",
  "test",
  "text",
  "time",
  "title",
  "transformer",
  "using",
  "with",
  "you",
]);

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
