import type { CitationMarker, CitationStyle, PageText } from "../types";

const NUMBERED_MARKER_RE = /\[\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*\]/g;
const NUMBERED_TOKEN_RE = /(\d+)(?:\s*[-–]\s*(\d+))?/g;
const BRACKET_KEY_MARKER_RE =
  /\[\s*([A-Za-z][A-Za-z0-9+_.:-]{1,24}(?:\s*[,;]\s*[A-Za-z][A-Za-z0-9+_.:-]{1,24})*)\s*\]/g;
const BRACKET_KEY_TOKEN_RE = /[A-Za-z][A-Za-z0-9+_.:-]{1,24}/g;
const BRACKET_AUTHOR_YEAR_RE = /\[([^[\]]{0,450}(?:19|20)\d{2}[a-z]?[^[\]]*)\]/g;
const PAREN_AUTHOR_YEAR_RE = /\(([^()]{0,450}(?:19|20)\d{2}[a-z]?[^()]*)\)/g;
const AUTHOR_YEAR_SURNAME = String.raw`[\p{Lu}][\p{L}\p{M}'’-]+(?:-\s*[\p{L}\p{M}'’-]+)?`;
const AUTHOR_YEAR_CAP_WORD_RE = new RegExp(AUTHOR_YEAR_SURNAME, "gu");
const AUTHOR_YEAR_RE = /\b((?:19|20)\d{2}[a-z]?)/g;
// Narrative form, where the author name sits OUTSIDE the delimiters and one or
// more years sit inside them: "Vaswani et al. (2017)", "Smith and Lee (2020)",
// "Ben-Porat and Tennenholtz [2017, 2019]", "Feng et al. [2019]". Both paren
// and bracket delimiters are accepted, as is a comma/semicolon-separated list
// of years that all cite the same narrated author(s).
const NARRATIVE_RE = new RegExp(
  String.raw`\b(${AUTHOR_YEAR_SURNAME})` +
    String.raw`(?:\s+(?:et al\.?|(?:and|&)\s+${AUTHOR_YEAR_SURNAME}))?` +
    String.raw`\s*[[(]\s*` +
    String.raw`((?:19|20)\d{2}[a-z]?(?:\s*[,;]\s*(?:19|20)\d{2}[a-z]?)*)` +
    String.raw`\s*[\])]`,
  "gu",
);

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
    // 4-digit values in a bracket are years from a narrative citation
    // ("Feng et al. [2019]", "Ben-Porat and Tennenholtz [2017, 2019]"), not
    // reference indices — a bibliography never has 1000+ numbered entries.
    // Leaving them to NARRATIVE_RE lets those cites resolve to the right work.
    if (from > 999 || to > 999) continue;
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

function keyedMarkers(page: PageText, match: RegExpExecArray): RawMarker[] {
  const markers: RawMarker[] = [];
  const raw = match[0];
  BRACKET_KEY_TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = BRACKET_KEY_TOKEN_RE.exec(raw))) {
    const tokenStart = match.index + token.index;
    markers.push({
      id: `p${page.pageNumber}-k${tokenStart}`,
      page: page.pageNumber,
      start: tokenStart,
      end: tokenStart + token[0].length,
      raw: token[0],
      citationKeys: [token[0]],
    });
  }
  return markers;
}

/**
 * "(Kingma and Ba, 2015; see Loshchilov and Hutter, 2019)" -> one marker per
 * cited work, with each marker spanning the author/year fragment it matched.
 *
 * Works cited together may be separated by semicolons ("A, 2019; B, 2020") or,
 * in many venues, by commas ("Kaplan et al., 2020, Sharma and Kaplan, 2022,
 * Bahri et al., 2021") where the comma also separates each author from its own
 * year. To handle both without confusing the two roles of the comma, each
 * cited work is taken to be the text between the previous work's year and the
 * next year — so the fragment for a work always ends at its year and starts
 * right after the prior work's year.
 */
function authorYearMarkers(
  page: PageText,
  match: RegExpExecArray,
): RawMarker[] {
  const group = match[1];
  const markers: RawMarker[] = [];
  AUTHOR_YEAR_RE.lastIndex = 0;
  let year: RegExpExecArray | null;
  let prevYearEnd = 0;
  let lastSurname: string | null = null;
  while ((year = AUTHOR_YEAR_RE.exec(group))) {
    const fragmentStart = prevYearEnd;
    prevYearEnd = year.index + year[0].length;
    const trimmedStart = trimCitationPrefix(group, fragmentStart, year.index);
    const fragment = group.slice(trimmedStart, year.index);
    let surname = extractCitedSurname(fragment);
    let start: number;
    if (surname) {
      lastSurname = surname;
      start = match.index + 1 + trimmedStart;
    } else if (lastSurname && fragment.trim() === "") {
      // "Liu et al., 2018, 2020" — a bare trailing year cites the same authors
      // as the previous work for an additional year.
      surname = lastSurname;
      start = match.index + 1 + year.index;
    } else {
      continue;
    }

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

/**
 * "Ben-Porat and Tennenholtz [2017, 2019]" / "Feng et al. [2019]" -> one marker
 * per bracketed year, each carrying the narrated author's surname. The first
 * year's marker spans the author name too so hovering the name works; later
 * years (same authors) highlight just the year.
 */
function narrativeMarkers(page: PageText, match: RegExpExecArray): RawMarker[] {
  const surname = match[1];
  const whole = match[0];
  const markers: RawMarker[] = [];
  AUTHOR_YEAR_RE.lastIndex = 0;
  let year: RegExpExecArray | null;
  let first = true;
  while ((year = AUTHOR_YEAR_RE.exec(whole))) {
    const yearStart = match.index + year.index;
    const start = first ? match.index : yearStart;
    const end = yearStart + year[0].length;
    markers.push({
      id: `p${page.pageNumber}-t${start}`,
      page: page.pageNumber,
      start,
      end,
      raw: page.text.slice(start, end),
      authorYears: [{ surname, year: year[1] }],
    });
    first = false;
  }
  return markers;
}

// Editorial lead-ins before a cited work: "see", "see also", "e.g.", "i.e.",
// "cf.", "also", "viz.", each possibly dotted and comma/space separated, and
// possibly stacked ("see, e.g.,"). Stripped so surname extraction sees the
// author, not the lead-in word.
const CITATION_PREFIX_RE =
  /^[\s,;]*(?:(?:see|also|cf|e\.?\s*g|i\.?\s*e|viz|e\.?\s*g\.?|resp)\.?[\s,;]*)*/i;

function trimCitationPrefix(group: string, start: number, end: number): number {
  const leading = group.slice(start, end).match(CITATION_PREFIX_RE);
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
    const key = `${marker.start}:${marker.end}:${marker.refNumbers?.join(",") ?? marker.citationKeys?.join(",") ?? marker.authorYears?.map((ay) => `${ay.surname}|${ay.year}`).join(",")}`;
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
 *
 * `style` restricts detection to the forms the paper actually uses (from its
 * bibliography): a numbered paper only has `[n]` markers, an author-year paper
 * only has author-year ones. This avoids cross-scheme false positives — e.g.
 * "(NeurIPS 2023)" resolving against an author-year entry, or a stray bracketed
 * number resolving in an author-year paper. Omit `style` to try every form
 * (used when there is no parsed bibliography to infer from).
 */
export function detectMarkersOnPage(
  page: PageText,
  exclude?: ExcludedRange,
  style?: CitationStyle,
): RawMarker[] {
  const text = page.text;
  const markers: RawMarker[] = [];
  const excluded = (index: number) => !!exclude && index >= exclude.start && index < exclude.end;
  const allow = (...styles: CitationStyle[]) => style === undefined || styles.includes(style);

  let m: RegExpExecArray | null;

  if (allow("numbered")) {
    NUMBERED_MARKER_RE.lastIndex = 0;
    while ((m = NUMBERED_MARKER_RE.exec(text))) {
      if (excluded(m.index)) continue;
      markers.push(...numberedMarkers(page, m));
    }
  }

  if (allow("alpha")) {
    BRACKET_KEY_MARKER_RE.lastIndex = 0;
    while ((m = BRACKET_KEY_MARKER_RE.exec(text))) {
      if (excluded(m.index)) continue;
      if (overlapsExisting(markers, m.index, m.index + m[0].length)) continue;
      markers.push(...keyedMarkers(page, m));
    }
  }

  if (allow("author-year")) {
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
      markers.push(...narrativeMarkers(page, m));
    }
  }

  return dedupeMarkers(markers).sort((a, b) => a.start - b.start);
}
