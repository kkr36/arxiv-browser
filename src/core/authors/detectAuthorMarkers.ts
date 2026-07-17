import type { AuthorMarker, AuthorProfileRef, PageText } from "../types";
import { buildPageLines, type PageLine } from "../pdf/buildLines";

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
    // The rotated arXiv stamp on page 1's margin is set in a very large font.
    // In layouts with no "Abstract" heading to bound the header (ACM PACM),
    // it would register as the page's largest "title" font and stop the real
    // title lines from being filtered out below.
    const lines = buildPageLines(page).filter((line) => !ARXIV_STAMP_RE.test(line.text));
    const abstractLineIndex = lines.findIndex((line) => /^\s*abstract\b/i.test(line.text));
    const headerLines = lines.slice(0, abstractLineIndex === -1 ? Math.min(lines.length, 80) : abstractLineIndex);
    // The title is the largest-font text at the top of the page; author names
    // are set smaller. Dropping title-sized lines stops a title fragment that
    // wraps to its own line ("Peer Review") from being read as an author. Only
    // applied when a smaller font actually exists below, so papers that set the
    // title and authors at the same size lose nothing.
    const searchLines = headerLines.filter((line) => !isTitleFontLine(line, headerLines));
    const lineTexts = searchLines.map((line) => line.text);
    const emailAnchored = authorsNearEmailLines(lineTexts);
    if (emailAnchored.length > 0) {
      candidates.push(...emailAnchored.map((name) => ({ name })));
      return dedupeAuthors(candidates);
    }
    const inlineAffiliationAuthors = authorsFromInlineAffiliationLines(lineTexts);
    if (inlineAffiliationAuthors.length > 0) {
      candidates.push(...inlineAffiliationAuthors.map((name) => ({ name })));
      return dedupeAuthors(candidates);
    }
    const stackedAffiliationAuthors = authorsFromStackedAffiliationLines(lineTexts);
    if (stackedAffiliationAuthors.length > 0) {
      candidates.push(...stackedAffiliationAuthors.map((name) => ({ name })));
      return dedupeAuthors(candidates);
    }
    for (const line of searchLines) {
      for (const name of namesFromLine(line.text)) {
        candidates.push({ name });
        if (candidates.length >= MAX_AUTHOR_CANDIDATES) return dedupeAuthors(candidates);
      }
    }
    if (abstractLineIndex !== -1 || candidates.length > 0) break;
  }

  return dedupeAuthors(candidates);
}

const TITLE_FONT_EPS = 1;

const ARXIV_STAMP_RE = /^\s*arxiv:\s*\S+/i;

/** True when `line` is set at the header's largest font (the title), and a
 * smaller font exists in the header (so real authors sit below the title). */
function isTitleFontLine(line: PageLine, headerLines: PageLine[]): boolean {
  const maxSize = Math.max(...headerLines.map((l) => l.fontSize));
  if (!(maxSize > 0)) return false;
  const hasSmaller = headerLines.some((l) => l.fontSize > 0 && l.fontSize < maxSize - TITLE_FONT_EPS);
  return hasSmaller && line.fontSize >= maxSize - TITLE_FONT_EPS;
}

function authorsNearEmailLines(lines: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\S+@\S+/.test(lines[i])) continue;
    // Walk up from the email line. Affiliation/blank lines above the emails
    // yield no names and are scanned past; once names start appearing (authors
    // are often stacked one per line), collect the whole run and stop at the
    // first gap so we don't reach into the title above.
    let started = false;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const allCapsName = standaloneAuthorNameFromLine(lines[j]);
      const lineNames = allCapsName ? [allCapsName] : namesFromLine(lines[j]);
      if (lineNames.length > 0) {
        names.push(...lineNames);
        started = true;
      } else if (started) {
        break;
      }
    }
  }
  return names;
}

/** ACM PACM-style headers put each author's affiliation on the same line as
 * the name: "DONGPING ZHANG, Northwestern University, USA". Collect the
 * leading comma-separated segments that read as person names, but only when
 * the rest of the line reads as an affiliation — otherwise the line is left
 * for the generic per-line parsing. */
function authorsFromInlineAffiliationLines(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    const segments = line
      .split(/\s*(?:,|;|\band\b|&|·|\|)\s*/iu)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) continue;

    const lineNames: string[] = [];
    let i = 0;
    for (; i < segments.length; i++) {
      if (INSTITUTION_LINE_RE.test(segments[i])) break;
      const name = personNameFromText(segments[i]);
      if (!name) break;
      lineNames.push(name);
    }
    if (lineNames.length === 0 || i >= segments.length) continue;
    if (isLikelyAffiliationLine(segments.slice(i).join(", "))) {
      names.push(...lineNames);
    }
  }
  return names;
}

function authorsFromStackedAffiliationLines(lines: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = standaloneAuthorNameFromLine(lines[i]);
    if (!name) continue;

    const prev = meaningfulLineBefore(lines, i);
    const next = meaningfulLineAfter(lines, i);
    if (isLikelyAffiliationLine(next) || isLikelyAffiliationLine(prev)) {
      names.push(name);
    }
  }
  return names;
}

function namesFromLine(line: string): string[] {
  const affiliationMarked = namesFromAffiliationMarkedLine(line);
  if (affiliationMarked.length > 0) return affiliationMarked;

  const cleaned = cleanAuthorLine(line);
  if (!cleaned || rejectAuthorLine(cleaned)) return [];

  const parts = cleaned
    .split(/\s*(?:,|;|\band\b|&|\u00b7|\|)\s*/iu)
    .map((part) => normalizeAuthorName(part))
    .filter(Boolean);
  if (parts.length > 1) return parts.filter(isLikelyPersonName);

  const unseparatedNames = namesFromUnseparatedLine(cleaned);
  if (unseparatedNames.length > 0) return unseparatedNames;

  const single = normalizeAuthorName(cleaned);
  return single && isLikelyPersonName(single) ? [single] : [];
}

function standaloneAuthorNameFromLine(line: string | undefined): string | null {
  if (!line || /[,;]|(?:\band\b)|&|\u00b7|\|/iu.test(line)) return null;
  return personNameFromText(line);
}

function personNameFromText(text: string): string | null {
  const cleaned = cleanAuthorLine(text);
  if (!cleaned || rejectAuthorLine(cleaned)) return null;

  const normalized = normalizeAuthorName(cleaned);
  if (normalized && isLikelyPersonName(normalized)) return normalized;

  const recased = recaseAllCapsName(normalized);
  return recased !== normalized && isLikelyPersonName(recased) ? recased : null;
}

function namesFromAffiliationMarkedLine(line: string): string[] {
  const names: string[] = [];
  const re =
    /((?:[\p{Lu}][\p{L}\p{M}'’.-]+|[\p{Lu}]\.)(?:\s+(?:[\p{Lu}][\p{L}\p{M}'’.-]+|[\p{Lu}]\.)){1,4})\s*(?:[*†‡§¶#]+\s*)?(?:\d+(?:\s*[,;]\s*\d+)*)\b/gu;

  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const name = normalizeAuthorName(match[1]);
    if (name && isLikelyPersonName(name)) names.push(name);
  }

  return names.length >= 2 ? names : [];
}

function meaningfulLineBefore(lines: string[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return undefined;
}

function meaningfulLineAfter(lines: string[], index: number): string | undefined {
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return undefined;
}

function recaseAllCapsName(name: string): string {
  if (!name || /[\p{Ll}]/u.test(name) || !/[\p{Lu}]{2}/u.test(name)) return name;
  return name
    .split(/\s+/)
    .map((token) => {
      if (/^[\p{Lu}]\.?$/u.test(token)) return token;
      return token.toLocaleLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_m, prefix, letter) => {
        return `${prefix}${letter.toLocaleUpperCase()}`;
      });
    })
    .join(" ");
}

function namesFromUnseparatedLine(line: string): string[] {
  const tokens = normalizeAuthorName(line).split(/\s+/).filter(Boolean);
  if (tokens.length < 4 || tokens.length > 12 || tokens.length % 2 !== 0) return [];
  if (!tokens.every((token) => /^[\p{Lu}][\p{L}\p{M}'’.-]+$/u.test(token))) return [];

  const names: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const name = `${tokens[i]} ${tokens[i + 1]}`;
    if (!isLikelyPersonName(name)) return [];
    names.push(name);
  }
  return names;
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
  if (INSTITUTION_LINE_RE.test(line)) return true;
  if (line.split(/\s+/).length > 12) return true;
  return false;
}

function isLikelyAffiliationLine(line: string | undefined): boolean {
  if (!line) return false;
  return /\S+@\S+/.test(line) || INSTITUTION_LINE_RE.test(line);
}

const INSTITUTION_LINE_RE =
  /\b(university|institute|department|school|college|laborator(?:y|ies)|labs?|research|brain|google|facebook|meta|microsoft|openai|deepmind|stanford|mit|berkeley|carnegie|cornell|harvard|tech|mail|gmail)\b/i;

function isLikelyPersonName(name: string): boolean {
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  const nameTokens = tokens.filter((token) => {
    if (/^[\p{Lu}]\.?$/u.test(token)) return true;
    return /^[\p{Lu}][\p{L}\p{M}'’.-]+$/u.test(token);
  });
  if (nameTokens.length < 2) return false;
  if (tokens.some((token) => /^[a-z]/.test(token))) return false;
  if (tokens.some(isNonNameToken)) return false;
  return true;
}

function isNonNameToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (COMMON_NON_NAME_WORDS.has(lower)) return true;
  if (/^[A-Z]{2,}s?$/.test(token)) return true;
  if (
    token.includes("-") &&
    !/^[\p{Lu}][\p{L}\p{M}'’]+-[\p{Lu}][\p{L}\p{M}'’]+$/u.test(token)
  ) {
    return true;
  }
  return false;
}

const COMMON_NON_NAME_WORDS = new Set([
  "a",
  "adaptation",
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
  "llm",
  "llms",
  "model",
  "models",
  "moving",
  "need",
  "new",
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
