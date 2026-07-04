import type { CitationMarker, PageText } from "../types";

const NUMBERED_MARKER_RE = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g;
const AUTHOR_YEAR_RE =
  /\(([A-Z][A-Za-z'\-]+(?:\s+(?:et al\.?|and|&)\s+[A-Za-z'\-]+)*,?\s*(?:19|20)\d{2}[a-z]?(?:;\s*[A-Z][A-Za-z'\-]+(?:\s+(?:et al\.?|and|&)\s+[A-Za-z'\-]+)*,?\s*(?:19|20)\d{2}[a-z]?)*)\)/g;
// Narrative form: "Vaswani et al. (2017)", "Smith and Lee (2020)", "Smith (2020)".
const NARRATIVE_RE =
  /\b([A-Z][A-Za-z'\-]+)(?:\s+(?:et al\.?|(?:and|&)\s+[A-Z][A-Za-z'\-]+))?\s*\(\s*((?:19|20)\d{2}[a-z]?)\s*\)/g;

export type RawMarker = Omit<CitationMarker, "entryIndices">;

/** Character range within a page's text where markers must not be reported. */
export interface ExcludedRange {
  start: number;
  end: number;
}

function expandRefNumbers(raw: string): number[] {
  const nums = new Set<number>();
  for (const part of raw.split(",")) {
    const rangeMatch = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      for (let n = from; n <= to && n - from < 200; n++) nums.add(n);
    } else {
      const n = Number(part.trim());
      if (!Number.isNaN(n)) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/** "(Kingma and Ba, 2015; Loshchilov and Hutter, 2019)" → one pair per work. */
function extractAuthorYears(group: string): { surname: string; year: string }[] {
  const pairs: { surname: string; year: string }[] = [];
  for (const part of group.split(";")) {
    const surnameMatch = part.trim().match(/^([A-Z][A-Za-z'\-]+)/);
    const yearMatch = part.match(/(19|20)\d{2}[a-z]?/);
    if (surnameMatch && yearMatch) {
      pairs.push({ surname: surnameMatch[1], year: yearMatch[0] });
    }
  }
  return pairs;
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
    markers.push({
      id: `p${page.pageNumber}-n${m.index}`,
      page: page.pageNumber,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      refNumbers: expandRefNumbers(m[1]),
    });
  }

  AUTHOR_YEAR_RE.lastIndex = 0;
  while ((m = AUTHOR_YEAR_RE.exec(text))) {
    if (excluded(m.index)) continue;
    const authorYears = extractAuthorYears(m[1]);
    if (authorYears.length === 0) continue;
    markers.push({
      id: `p${page.pageNumber}-a${m.index}`,
      page: page.pageNumber,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      authorYears,
    });
  }

  NARRATIVE_RE.lastIndex = 0;
  while ((m = NARRATIVE_RE.exec(text))) {
    if (excluded(m.index)) continue;
    markers.push({
      id: `p${page.pageNumber}-t${m.index}`,
      page: page.pageNumber,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      authorYears: [{ surname: m[1], year: m[2] }],
    });
  }

  return markers.sort((a, b) => a.start - b.start);
}
