import type { CitationMarker, PageText } from "../types";

const NUMBERED_MARKER_RE = /\[\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*\]/g;
const NUMBERED_TOKEN_RE = /(\d+)(?:\s*[-–]\s*(\d+))?/g;
const BRACKET_AUTHOR_YEAR_RE = /\[([^[\]]{0,450}(?:19|20)\d{2}[a-z]?[^[\]]*)\]/g;
const PAREN_AUTHOR_YEAR_RE = /\(([^()]{0,450}(?:19|20)\d{2}[a-z]?[^()]*)\)/g;
const AUTHOR_YEAR_SURNAME = String.raw`[\p{Lu}][\p{L}\p{M}'’-]+(?:-\s*[\p{L}\p{M}'’-]+)?`;
const AUTHOR_YEAR_CAP_WORD_RE = new RegExp(AUTHOR_YEAR_SURNAME, "gu");
const AUTHOR_YEAR_RE = /\b((?:19|20)\d{2}[a-z]?)/g;
// Narrative form: "Vaswani et al. (2017)", "Smith and Lee (2020)", "Smith (2020)".
const NARRATIVE_RE =
  /\b([A-Z][A-Za-z'\-]+)(?:\s+(?:et al\.?|(?:and|&)\s+[A-Z][A-Za-z'\-]+))?\s*\(\s*((?:19|20)\d{2}[a-z]?)\s*\)/g;

export type RawMarker = Omit<CitationMarker, "entryIndices">;

/** Character range within a page's text where markers must not be reported. */
export interface ExcludedRange {
  start: number;
  end: number;
}

function expandRefRange(from: number, to: number): number[] {
  const nums: number[] = [];
  for (let n = from; n <= to && n - from < 200; n++) nums.push(n);
  return nums;
}

function numberedMarkers(
  page: PageText,
  match: RegExpExecArray,
): RawMarker[] {
  const markers: RawMarker[] = [];
  const raw = match[0];
  NUMBERED_TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = NUMBERED_TOKEN_RE.exec(raw))) {
    const from = Number(token[1]);
    const to = token[2] ? Number(token[2]) : from;
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    const tokenStart = match.index + token.index;
    markers.push({
      id: `p${page.pageNumber}-n${tokenStart}`,
      page: page.pageNumber,
      start: tokenStart,
      end: tokenStart + token[0].length,
      raw: token[2] ? token[0] : `[${from}]`,
      refNumbers: from <= to ? expandRefRange(from, to) : [from],
    });
  }
  return markers;
}

/**
 * "(Kingma and Ba, 2015; see Loshchilov and Hutter, 2019)" -> one marker per
 * cited work, with each marker spanning the author/year fragment it matched.
 */
function authorYearMarkers(
  page: PageText,
  match: RegExpExecArray,
): RawMarker[] {
  const group = match[1];
  const markers: RawMarker[] = [];
  AUTHOR_YEAR_RE.lastIndex = 0;
  let year: RegExpExecArray | null;
  while ((year = AUTHOR_YEAR_RE.exec(group))) {
    const fragmentStart = fragmentStartBeforeYear(group, year.index);
    const trimmedStart = trimCitationPrefix(group, fragmentStart, year.index);
    const surname = extractCitedSurname(group.slice(trimmedStart, year.index));
    if (!surname) continue;

    const start = match.index + 1 + trimmedStart;
    const end = match.index + 1 + year.index + year[0].length;
    const raw = group.slice(trimmedStart, year.index + year[0].length).trim();
    markers.push({
      id: `p${page.pageNumber}-a${start}`,
      page: page.pageNumber,
      start,
      end,
      raw,
      authorYears: [{ surname, year: year[1] }],
    });
  }
  return markers;
}

function fragmentStartBeforeYear(group: string, yearIndex: number): number {
  const semicolon = group.lastIndexOf(";", yearIndex);
  return semicolon === -1 ? 0 : semicolon + 1;
}

function trimCitationPrefix(group: string, start: number, end: number): number {
  const leading = group.slice(start, end).match(/^[,;\s]*(?:(?:see|also|e\.g\.|cf\.)\s+)*/i);
  return start + (leading?.[0].length ?? 0);
}

function extractCitedSurname(text: string): string | null {
  const cleaned = text.trim().replace(/[,;\s]+$/, "");
  if (!cleaned) return null;

  const etAl = cleaned.match(new RegExp(`(${AUTHOR_YEAR_SURNAME})\\s+et\\s+al\\.?`, "u"));
  if (etAl) return etAl[1];

  const firstComma = cleaned.indexOf(",");
  const restAfterComma = firstComma === -1 ? "" : cleaned.slice(firstComma + 1);
  AUTHOR_YEAR_CAP_WORD_RE.lastIndex = 0;
  const authorText =
    firstComma !== -1 && AUTHOR_YEAR_CAP_WORD_RE.test(restAfterComma)
      ? cleaned.slice(0, firstComma)
      : cleaned;
  AUTHOR_YEAR_CAP_WORD_RE.lastIndex = 0;

  const conjunction = authorText.search(/\s+(?:and|&)\s+/);
  const firstAuthor = conjunction === -1 ? authorText : authorText.slice(0, conjunction);
  const words = [...firstAuthor.matchAll(AUTHOR_YEAR_CAP_WORD_RE)].map((m) => m[0]);
  return words.at(-1) ?? null;
}

function overlapsExisting(markers: RawMarker[], start: number, end: number): boolean {
  return markers.some((m) => {
    if (m.refNumbers) return false;
    return start < m.end && end > m.start;
  });
}

function dedupeMarkers(markers: RawMarker[]): RawMarker[] {
  const seen = new Set<string>();
  const out: RawMarker[] = [];
  for (const marker of markers) {
    const key = `${marker.start}:${marker.end}:${marker.refNumbers?.join(",") ?? marker.authorYears?.map((ay) => `${ay.surname}|${ay.year}`).join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(marker);
    }
  }
  return out;
}

/**
 * Finds inline citation markers ([12], [3,4], [5-7], (Smith et al., 2020),
 * or narrative "Smith et al. (2020)") within a page's text. Markers whose
 * start falls inside `exclude` are dropped — used to skip the bibliography
 * section itself, so we don't match reference numbers/page ranges inside
 * the entries as if they were in-text citations.
 */
export function detectMarkersOnPage(page: PageText, exclude?: ExcludedRange): RawMarker[] {
  const text = page.text;
  const markers: RawMarker[] = [];
  const excluded = (index: number) => !!exclude && index >= exclude.start && index < exclude.end;

  let m: RegExpExecArray | null;

  NUMBERED_MARKER_RE.lastIndex = 0;
  while ((m = NUMBERED_MARKER_RE.exec(text))) {
    if (excluded(m.index)) continue;
    markers.push(...numberedMarkers(page, m));
  }

  BRACKET_AUTHOR_YEAR_RE.lastIndex = 0;
  while ((m = BRACKET_AUTHOR_YEAR_RE.exec(text))) {
    if (excluded(m.index)) continue;
    markers.push(...authorYearMarkers(page, m));
  }

  PAREN_AUTHOR_YEAR_RE.lastIndex = 0;
  while ((m = PAREN_AUTHOR_YEAR_RE.exec(text))) {
    if (excluded(m.index)) continue;
    markers.push(...authorYearMarkers(page, m));
  }

  NARRATIVE_RE.lastIndex = 0;
  while ((m = NARRATIVE_RE.exec(text))) {
    if (excluded(m.index)) continue;
    if (overlapsExisting(markers, m.index, m.index + m[0].length)) continue;
    markers.push({
      id: `p${page.pageNumber}-t${m.index}`,
      page: page.pageNumber,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      authorYears: [{ surname: m[1], year: m[2] }],
    });
  }

  return dedupeMarkers(markers).sort((a, b) => a.start - b.start);
}
