import { buildPageLines, type PageLine } from "../pdf/buildLines";
import type { BibEntry, PageText } from "../types";

// Compared against the line with whitespace/periods stripped, so letter-spaced
// small-caps headings ("R E F E R E N C E S") and "7. References" both match.
const COMPACT_HEADING_RE = /^\d{0,2}(references|bibliography)$/;
const STOP_RE = /^([A-Z0-9]{1,3}[.\s:]+)?(appendix|acknowledg(e)?ments?|supplementary material)\b/i;
const BRACKET_NUMBER_RE = /^\[(\d+)\]\s*/;
const DOTTED_NUMBER_RE = /^(\d{1,3})\.\s+(?=[A-Z(])/;

export interface BibliographyParseResult {
  entries: BibEntry[];
  headingPage: number;
  headingStart: number;
  /** Page/offset of the line that ends the bibliography (appendix or
   * acknowledgments heading), or null when it runs to the end of the doc. */
  endPage: number | null;
  endOffset: number | null;
}

/**
 * Locates the References/Bibliography section and splits it into individual
 * entries. Entries are detected primarily by hanging-indent (a line whose
 * left edge outdents relative to the previous line starts a new entry),
 * with numbered-bracket/dotted prefixes as a higher-confidence override.
 * Column and page breaks are excluded from the indent comparison since a
 * two-column layout's column jump looks like an outdent otherwise.
 */
export function parseBibliography(pages: PageText[]): BibliographyParseResult | null {
  const allLines = pages.flatMap(buildPageLines);

  const headingIdx = allLines.findIndex((l) =>
    COMPACT_HEADING_RE.test(l.text.replace(/[\s.]+/g, "").toLowerCase()),
  );
  if (headingIdx === -1) return null;
  const heading = allLines[headingIdx];

  let stopIdx = allLines.length;
  for (let i = headingIdx + 1; i < allLines.length; i++) {
    if (STOP_RE.test(allLines[i].text.trim())) {
      stopIdx = i;
      break;
    }
  }
  const stopLine = stopIdx < allLines.length ? allLines[stopIdx] : null;

  const bibLines = allLines
    .slice(headingIdx + 1, stopIdx)
    .filter((l) => l.text.trim().length > 0)
    // Bare page numbers between entries would otherwise be glued into
    // whichever entry spans the page break.
    .filter((l) => !/^\d{1,4}$/.test(l.text.trim()));
  if (bibLines.length === 0) return null;

  const groups = groupLinesIntoEntries(bibLines);
  const numberedGroups = groups.filter(groupStartsWithNumber);
  // In numbered bibliographies, any unnumbered groups after the final entry
  // are almost always later sections/captions that follow the references.
  const referenceGroups = numberedGroups.length >= 2 ? numberedGroups : groups;

  const entries: BibEntry[] = referenceGroups
    .map((lines, index) => buildEntry(lines, index))
    .filter((e) => e.rawText.length > 8);

  return {
    entries,
    headingPage: heading.page,
    headingStart: heading.start,
    endPage: stopLine?.page ?? null,
    endOffset: stopLine?.start ?? null,
  };
}

function groupStartsWithNumber(lines: PageLine[]): boolean {
  const first = lines[0]?.text.trim() ?? "";
  return BRACKET_NUMBER_RE.test(first) || DOTTED_NUMBER_RE.test(first);
}

const COLUMN_X_JUMP = 100;
const COLUMN_Y_JUMP = 150;
const OUTDENT_EPS = 3;

function isBreakBetween(a: PageLine, b: PageLine): boolean {
  return (
    b.page !== a.page || b.y > a.y + COLUMN_Y_JUMP || Math.abs(b.x - a.x) > COLUMN_X_JUMP
  );
}

function groupLinesIntoEntries(lines: PageLine[]): PageLine[][] {
  const groups: PageLine[][] = [];
  let current: PageLine[] = [];
  let prev: PageLine | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.text.trim();
    const numberedStart = BRACKET_NUMBER_RE.test(trimmed) || DOTTED_NUMBER_RE.test(trimmed);

    let isNewEntry: boolean;
    if (numberedStart) {
      isNewEntry = true;
    } else if (!prev) {
      isNewEntry = true;
    } else if (!isBreakBetween(prev, line)) {
      isNewEntry = line.x < prev.x - OUTDENT_EPS;
    } else {
      // The indent comparison is meaningless across a column/page break, so
      // peek ahead instead: a hanging-indent entry starts flush left with its
      // continuation indented, so a following line that indents relative to
      // this one marks this line as an entry start (not a continuation of the
      // entry left hanging in the previous column).
      const next = lines[i + 1];
      isNewEntry = !!next && !isBreakBetween(line, next) && next.x > line.x + OUTDENT_EPS;
    }

    if (isNewEntry && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(line);
    prev = line;
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

function buildEntry(lines: PageLine[], index: number): BibEntry {
  const rawJoined = lines
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const bracketMatch = rawJoined.match(/^\[(\d+)\]\s*/);
  const dottedMatch = !bracketMatch && rawJoined.match(/^(\d{1,3})\.\s+/);
  const number = bracketMatch
    ? Number(bracketMatch[1])
    : dottedMatch
      ? Number(dottedMatch[1])
      : undefined;

  const rawText = rawJoined.replace(/^\[\d+\]\s*/, "").replace(/^\d{1,3}\.\s+/, "");

  return {
    index,
    number,
    authorYearKey: extractAuthorYearKey(rawText),
    rawText,
  };
}

function extractAuthorYearKey(text: string): { surname: string; year: string } | undefined {
  // (?!\.\d) keeps arXiv ids like "arXiv:1906.04043" from posing as years.
  const yearMatch = text.match(/\b(19|20)\d{2}[a-z]?\b(?!\.\d)/);
  if (!yearMatch) return undefined;
  // In-text markers cite the first author's SURNAME, which is the last word
  // of the first author however the list is written: "Alan Akbik, Duncan
  // Blythe…" → Akbik; "Devlin, J." → Devlin; "J. K. Smith and B. Jones" →
  // Smith. Cut the author sentence, take the first author (up to a comma or
  // "and"), then its last capitalized word of 2+ letters (skips initials).
  const authorSentence = text.split(/(?<=[a-z)])\.\s+/)[0];
  const firstAuthor = authorSentence.split(/,|\band\b|&/)[0];
  const capWords = firstAuthor.match(/[A-Z][A-Za-z'\-]+/g);
  const surname = capWords?.[capWords.length - 1];
  if (surname) return { surname, year: yearMatch[0] };
  return undefined;
}
